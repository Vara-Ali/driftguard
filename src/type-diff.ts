import axios from 'axios';
import { getPackageMetadata } from './npm-metadata';

/**
 * Diffs a package's public surface between two versions.
 *
 * Release notes say what the maintainer *chose* to mention. The type
 * definitions say what actually changed. When those two disagree — a method
 * quietly gaining a required parameter, say — the type diff is the one that
 * predicts your build breaking, so it is worth the extra fetches.
 *
 * Files come from unpkg, falling back to jsDelivr. Both serve published npm
 * artifacts directly, so this works for any version ever published without
 * needing to install anything.
 */

export interface TypeDiff {
  /** Path within the package that was compared, e.g. `index.d.ts`. */
  path: string;
  oldVersion: string;
  newVersion: string;
  oldLineCount: number;
  newLineCount: number;
  /** Lines present only in the new version. */
  added: string[];
  /** Lines present only in the old version. */
  removed: string[];
  /**
   * Declared names present only in the new version. Immune to reformatting,
   * so this is the trustworthy signal when a release reflows its types.
   */
  symbolsAdded: string[];
  /** Declared names present only in the old version — candidate breaking removals. */
  symbolsRemoved: string[];
  /** Unified-style diff with a few lines of context around each change. */
  unifiedDiff: string;
  /** Which CDN served the files. */
  source: 'unpkg' | 'jsdelivr';
  /** True when the diff was too large to compute exactly and was approximated. */
  approximated: boolean;
  /** True when the line diff looks like a reformat rather than real change. */
  looksReformatted: boolean;
}

export interface DiffTypesOptions {
  /** Called with a human-readable reason when the diff cannot be produced. */
  onUnavailable?: (reason: string) => void;
  /** Lines of context to include around each hunk. */
  context?: number;
}

const CDNS = {
  unpkg: (pkg: string, version: string, path: string) =>
    `https://unpkg.com/${pkg}@${version}/${path}`,
  jsdelivr: (pkg: string, version: string, path: string) =>
    `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${path}`,
} as const;

/**
 * Above this many cells the exact LCS is not worth the memory, and we fall
 * back to a coarse line-set comparison. A 2,500 x 2,500 file pair is ~6M
 * cells at 4 bytes each — around 25MB, which is fine. The limit exists to
 * stop a pathological pair from exhausting memory, not to save a few MB.
 */
const LCS_CELL_LIMIT = 20_000_000;

const FETCH_TIMEOUT_MS = 15_000;

/** Fetch one file for one version, trying unpkg then jsDelivr. */
async function fetchFile(
  packageName: string,
  version: string,
  path: string,
): Promise<{ content: string; source: 'unpkg' | 'jsdelivr' } | null> {
  for (const source of ['unpkg', 'jsdelivr'] as const) {
    try {
      const response = await axios.get<string>(CDNS[source](packageName, version, path), {
        timeout: FETCH_TIMEOUT_MS,
        // Force text — axios would otherwise try to parse a .json entry point.
        responseType: 'text',
        transformResponse: [(data) => data],
      });

      if (typeof response.data === 'string' && response.data.length > 0) {
        return { content: response.data, source };
      }
    } catch {
      // Try the next CDN before giving up.
    }
  }

  return null;
}

/** Strip a leading `./` so CDN paths join cleanly. */
function normalizePath(entry: string): string {
  return entry.replace(/^\.\//, '');
}

/**
 * Work out which file best represents the package's public API.
 * Prefers declared types, then a conventional index.d.ts, then the main entry.
 */
async function resolveComparisonPath(packageName: string, version: string): Promise<string[]> {
  const candidates: string[] = [];

  try {
    const metadata = await getPackageMetadata(packageName, version);
    if (metadata.typesPath) {
      candidates.push(normalizePath(metadata.typesPath));
    }
    if (metadata.mainPath) {
      candidates.push(normalizePath(metadata.mainPath));
    }
  } catch {
    // Fall through to conventional guesses.
  }

  candidates.push('index.d.ts', 'types/index.d.ts', 'dist/index.d.ts', 'index.js');

  return [...new Set(candidates)];
}

/**
 * Reduce a line to what matters for API comparison.
 *
 * A release that only reformats — adding semicolons, reflowing indentation —
 * would otherwise register as every line changing. Comparing on this key means
 * cosmetic churn collapses and real signature changes stand out. The original
 * text is kept for display; only matching uses the key.
 */
function normalizeLine(line: string): string {
  return line
    .replace(/\/\/.*$/, '')       // trailing line comments
    .replace(/\s+/g, ' ')          // collapse all whitespace runs
    .replace(/[;,]\s*$/, '')      // trailing punctuation
    .trim();
}

/**
 * Blank out comments while preserving line structure.
 *
 * Necessary before any bracket counting: JSDoc is full of prose brackets like
 * "(WhatsApp default)" or "[optional]" that do not balance against real code,
 * and a single unmatched one desyncs the depth scan for the rest of the file.
 * That desync is not hypothetical — it made four parameter names look like new
 * API in the 1.34.6 → 1.34.7 comparison. Newlines are kept so line numbers and
 * per-line matching stay aligned.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Extract declared names from a type definition file.
 *
 * Deliberately regex-based rather than a real TypeScript parse: it only needs
 * to be right about *names*, it must never throw on odd syntax, and it must
 * stay immune to formatting. A symbol disappearing here is a far stronger
 * breaking-change signal than any number of changed lines.
 *
 * The paren-depth tracking is what makes it trustworthy. When a release
 * reflows `foo(a: string, b: number)` onto separate lines, each parameter
 * suddenly looks like a member declaration. Counting bracket depth means
 * anything inside an open signature is skipped, so parameter names never
 * masquerade as API symbols — which matters because a false "symbol removed"
 * would send the Day 3 summarizer chasing a breaking change that never
 * happened.
 */
export function extractSymbols(source: string): Set<string> {
  const symbols = new Set<string>();
  const code = stripComments(source);

  const declaration = /\b(?:class|interface|enum|namespace|type)\s+([A-Za-z_$][\w$]*)/g;
  const member =
    /^[ \t]*(?:(?:public|private|protected|readonly|static|abstract|declare|export|async)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*[(:<]/;

  for (const match of code.matchAll(declaration)) {
    symbols.add(match[1]);
  }

  let depth = 0;

  for (const line of code.split('\n')) {
    // Only consider a line a declaration when no signature is currently open.
    if (depth === 0) {
      const match = line.match(member);
      if (match) {
        symbols.add(match[1]);
      }
    }

    for (const char of line) {
      if (char === '(' || char === '[') depth++;
      else if (char === ')' || char === ']') depth--;
    }

    // Unbalanced brackets should not desync the whole scan.
    if (depth < 0) depth = 0;
  }

  // Language keywords and ambient types that slip through the member pattern.
  const noise = [
    'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'import', 'export',
    'declare', 'function', 'const', 'let', 'var', 'type', 'class', 'interface',
    'enum', 'namespace', 'extends', 'implements', 'else', 'do', 'try',
    'Array', 'Promise', 'Record', 'Map', 'Set', 'Partial', 'Readonly', 'Omit',
    'Pick', 'Exclude', 'Extract', 'Object', 'String', 'Number', 'Boolean',
  ];
  for (const word of noise) {
    symbols.delete(word);
  }

  return symbols;
}

interface Line {
  text: string;
  key: string;
}

type Op = { type: '=' | '-' | '+'; line: string };

/**
 * Exact line diff via longest-common-subsequence, matching on normalized keys.
 * Callers trim the common prefix and suffix first, so `a` and `b` here are
 * usually the small changed window rather than whole files.
 */
function lcsDiff(a: Line[], b: Line[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i].key === b[j].key
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i].key === b[j].key) {
      ops.push({ type: '=', line: a[i].text });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: '-', line: a[i].text });
      i++;
    } else {
      ops.push({ type: '+', line: b[j].text });
      j++;
    }
  }

  while (i < n) ops.push({ type: '-', line: a[i++].text });
  while (j < m) ops.push({ type: '+', line: b[j++].text });

  return ops;
}

/** Coarse fallback when the changed window is too large for an exact LCS. */
function coarseDiff(a: Line[], b: Line[]): Op[] {
  const inB = new Set(b.map((l) => l.key));
  const inA = new Set(a.map((l) => l.key));

  return [
    ...a.filter((l) => !inB.has(l.key)).map((l): Op => ({ type: '-', line: l.text })),
    ...b.filter((l) => !inA.has(l.key)).map((l): Op => ({ type: '+', line: l.text })),
  ];
}

/** Diff two files, trimming the shared prefix and suffix before the expensive part. */
function diffText(oldText: string, newText: string): { ops: Op[]; approximated: boolean } {
  const toLines = (text: string): Line[] =>
    text.split('\n').map((textLine) => ({ text: textLine, key: normalizeLine(textLine) }));

  const oldLines = toLines(oldText);
  const newLines = toLines(newText);

  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start].key === newLines[start].key
  ) {
    start++;
  }

  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1].key === newLines[endNew - 1].key) {
    endOld--;
    endNew--;
  }

  const a = oldLines.slice(start, endOld);
  const b = newLines.slice(start, endNew);

  const approximated = a.length * b.length > LCS_CELL_LIMIT;
  const middle = approximated ? coarseDiff(a, b) : lcsDiff(a, b);

  return {
    ops: [
      ...oldLines.slice(0, start).map((l): Op => ({ type: '=', line: l.text })),
      ...middle,
      ...oldLines.slice(endOld).map((l): Op => ({ type: '=', line: l.text })),
    ],
    approximated,
  };
}

/** Render changed regions with surrounding context, skipping untouched stretches. */
function renderUnified(ops: Op[], context: number): string {
  const changedAt = ops.map((op) => op.type !== '=');
  const keep = new Array<boolean>(ops.length).fill(false);

  for (let i = 0; i < ops.length; i++) {
    if (changedAt[i]) {
      for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) {
        keep[j] = true;
      }
    }
  }

  const lines: string[] = [];
  let skipping = false;

  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      if (!skipping) {
        lines.push('  ...');
        skipping = true;
      }
      continue;
    }
    skipping = false;
    lines.push(`${ops[i].type === '=' ? ' ' : ops[i].type} ${ops[i].line}`);
  }

  return lines.join('\n');
}

/**
 * Diff the public API surface of a package between two versions.
 *
 * Returns null when the comparison cannot be made — the package publishes no
 * types, the CDN has no such file, or the network failed. Pass
 * `options.onUnavailable` to find out which.
 */
export async function diffTypes(
  packageName: string,
  oldVersion: string,
  newVersion: string,
  options: DiffTypesOptions = {},
): Promise<TypeDiff | null> {
  const { onUnavailable, context = 3 } = options;
  const paths = await resolveComparisonPath(packageName, newVersion);

  for (const path of paths) {
    const [oldFile, newFile] = await Promise.all([
      fetchFile(packageName, oldVersion, path),
      fetchFile(packageName, newVersion, path),
    ]);

    if (!oldFile || !newFile) {
      continue;
    }

    const { ops, approximated } = diffText(oldFile.content, newFile.content);
    const added = ops.filter((op) => op.type === '+').map((op) => op.line);
    const removed = ops.filter((op) => op.type === '-').map((op) => op.line);

    const oldSymbols = extractSymbols(oldFile.content);
    const newSymbols = extractSymbols(newFile.content);
    const symbolsAdded = [...newSymbols].filter((s) => !oldSymbols.has(s)).sort();
    const symbolsRemoved = [...oldSymbols].filter((s) => !newSymbols.has(s)).sort();

    const lineChurn = added.length + removed.length;
    const symbolChurn = symbolsAdded.length + symbolsRemoved.length;
    // Heavy line churn with almost no symbol churn means the release reflowed
    // its types rather than changing them. Worth saying out loud, because the
    // line diff is close to useless in that case.
    const looksReformatted = lineChurn > 100 && symbolChurn * 20 < lineChurn;

    const common = {
      path,
      oldVersion,
      newVersion,
      oldLineCount: oldFile.content.split('\n').length,
      newLineCount: newFile.content.split('\n').length,
      symbolsAdded,
      symbolsRemoved,
      source: newFile.source,
      approximated,
      looksReformatted,
    };

    if (added.length === 0 && removed.length === 0) {
      onUnavailable?.(`${path} is byte-identical between ${oldVersion} and ${newVersion}.`);
      return { ...common, added: [], removed: [], unifiedDiff: '(no changes)' };
    }

    return { ...common, added, removed, unifiedDiff: renderUnified(ops, context) };
  }

  onUnavailable?.(
    `Could not fetch a comparable file for ${packageName} at both ${oldVersion} and ` +
      `${newVersion}. Tried: ${paths.join(', ')}.`,
  );
  return null;
}
