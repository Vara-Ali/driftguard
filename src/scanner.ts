import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Day 4: codebase usage scanner.
 *
 * Given the `{ name, reason }[]` array from the Day 3 verdict, find every
 * real call site of each removed/affected symbol in a target repository.
 *
 * Speed and correctness > AST precision for this MVP. We use ripgrep when
 * it is available — it already does binary detection, .gitignore respect,
 * and parallel traversal — and fall back to a manual recursive walker when
 * it is not. AST parsing is deliberately not attempted: Day 2 showed that
 * formatting-sensitive parsing is fragile, and ripgrep on real identifiers
 * is already good enough to find genuine call sites.
 */

import type { AffectedMethod } from './llm-client';

export interface CodeMatch {
  /** Absolute or repo-relative file path. Always repo-relative when set. */
  file: string;
  /** 1-based line number within the file. */
  line: number;
  /** The full line of code containing the match. */
  code: string;
}

export interface SymbolUsage {
  /** Symbol name as returned by Day 3. */
  symbolName: string;
  /** The reason the LLM gave for flagging it. Carried through for context. */
  reason: string;
  /** Every match in the target repo. */
  matches: CodeMatch[];
  /** Match count, surfaced separately so it is visible in the demo. */
  matchCount: number;
  /** "ripgrep" or "manual-walker" — which backend produced the results. */
  backend: 'ripgrep' | 'manual-walker';
}

export interface ScanResult {
  targetPath: string;
  backend: 'ripgrep' | 'manual-walker';
  /** True if the target directory existed and was readable. */
  scanned: boolean;
  /** Per-symbol results in the order they were queried. */
  usages: SymbolUsage[];
  /** Symbols that produced at least one match. */
  anyHits: boolean;
}

/** Directories we never want to descend into. */
const NOISE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'out',
];

/** File extensions ripgrep should consider when scanning codebases. */
const CODE_FILE_GLOBS = [
  '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs',
  '*.vue', '*.svelte',
  '*.py', '*.rb', '*.go', '*.java', '*.kt',
  '*.rs', '*.c', '*.cc', '*.cpp', '*.h', '*.hpp',
  '*.cs', '*.php', '*.swift', '*.m', '*.mm',
  '*.scala', '*.clj',
];

/**
 * Resolve the `rg` binary path.
 *
 * A standalone `execFileSync('rg', ['--version'])` probe was the first
 * implementation, and `execFileSync('which', ['rg'])` was the second —
 * both failed on this WSL system because the child-process PATH inherited
 * at exec time did not include the directory holding `rg`, even though
 * the shell `which rg` and the user's interactive shell found it just
 * fine. Subprocess PATH inheritance on Linux is not reliable for tools
 * installed outside the FHS-default paths.
 *
 * So instead we look in a small list of likely paths directly. Order
 * matters: prefer user-local installs before system ones, since both
 * usually work but the user-local one is what is actually present on
 * dev boxes.
 */
const RG_CANDIDATE_PATHS = [
  '/usr/local/bin/rg',
  '/usr/bin/rg',
  '/snap/bin/rg',
  '/opt/homebrew/bin/rg',
  '/home/vara/.cargo/bin/rg',
  '/home/vara/.local/bin/rg',
];

let cachedRgPath: string | null | undefined;
function getRipgrepExecutable(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;
  const fs = require('fs') as typeof import('fs');
  for (const candidate of RG_CANDIDATE_PATHS) {
    try {
      if (fs.statSync(candidate).isFile()) {
        cachedRgPath = candidate;
        return cachedRgPath;
      }
    } catch {
      // not present, keep looking
    }
  }
  cachedRgPath = null;
  return null;
}

/**
 * Build the ripgrep `-g` exclusion arguments that match NOISE_DIRS anywhere
 * in a path. The double-star-slash pattern matches the directory at any
 * depth, so noise like `packages/foo/node_modules/...` is excluded too.
 */
function rgExcludes(): string[] {
  const args: string[] = [];
  for (const dir of NOISE_DIRS) {
    args.push('--glob', `!**/${dir}/**`);
    args.push('--glob', `!**/${dir}`);
  }
  return args;
}

/**
 * One ripgrep call for one symbol. Returns `[]` on any failure — better to
 * report zero than to crash the whole scan because one query was odd.
 */
function rgSearchOne(targetPath: string, symbol: string): CodeMatch[] {
  const rgPath = getRipgrepExecutable();
  if (!rgPath) return [];

  try {
    // `--line-number` + `--no-heading` gives one match per line in the form
    // `path:line:content`. We split on the first two colons only, since the
    // matching line itself may legally contain colons.
    const raw = execFileSync(
      rgPath,
      [
        '--line-number',
        '--no-heading',
        '--with-filename',
        '--color', 'never',
        ...rgExcludes(),
        '--type-add', `code:*{${CODE_FILE_GLOBS.join(',')}}`,
        '-tcode',
        '--', symbol, targetPath,
      ],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );

    const matches: CodeMatch[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const firstColon = line.indexOf(':');
      const secondColon = firstColon === -1 ? -1 : line.indexOf(':', firstColon + 1);
      if (firstColon === -1 || secondColon === -1) continue;
      const file = line.slice(0, firstColon);
      const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
      const code = line.slice(secondColon + 1);
      if (Number.isFinite(lineNum)) {
        matches.push({ file, line: lineNum, code });
      }
    }
    return matches;
  } catch (error) {
    // rg exits 1 when no matches — that is normal, not an error.
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    if (status === 2) {
      // Usage error (bad pattern). Surface the message rather than silently
      // dropping the symbol — a degraded scan is worse than an honest zero.
      console.error(`  rg exited 2 for "${symbol}": ${(error as Error).message.split('\n').pop()}`);
      return [];
    }
    return [];
  }
}

/**
 * Manual recursive walker. Slow and primitive but works without ripgrep —
 * important for CI environments that may not have `rg` installed.
 */

function isProbablyCodeFile(filename: string): boolean {
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.py', '.rb', '.go', '.java', '.kt', '.rs', '.c', '.cc', '.cpp', '.h',
    '.hpp', '.cs', '.php', '.swift', '.m', '.scala', '.clj'];
  const lower = filename.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (NOISE_DIRS.includes(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && isProbablyCodeFile(entry.name)) {
      yield full;
    }
  }
}

function manualSearchOne(targetPath: string, symbol: string): CodeMatch[] {
  const matches: CodeMatch[] = [];
  for (const file of walk(targetPath)) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(symbol)) {
        matches.push({
          file: path.relative(targetPath, file),
          line: i + 1,
          code: lines[i],
        });
      }
    }
  }
  return matches;
}

/**
 * Search the target repo for every symbol in the Day 3 `affectedMethods`
 * array. Per-symbol counts are preserved so generic names like `session`
 * show their noise level in the demo.
 *
 * Returns a `ScanResult` even when the target directory is missing — that
 * is a configuration problem, not a crash.
 */
export async function findUsages(
  affectedMethods: AffectedMethod[],
  targetRepoPath: string,
): Promise<ScanResult> {
  // Pick a backend the first time we're called. Decision: prefer ripgrep
  // if its binary is locatable; fall back to the manual walker otherwise.
  const backend: 'ripgrep' | 'manual-walker' = getRipgrepExecutable() ? 'ripgrep' : 'manual-walker';

  const usages: SymbolUsage[] = [];

  let scanned = true;
  try {
    const stat = fs.statSync(targetRepoPath);
    if (!stat.isDirectory()) scanned = false;
  } catch {
    scanned = false;
  }

  if (scanned) {
    for (const method of affectedMethods) {
      const matches = backend === 'ripgrep'
        ? rgSearchOne(targetRepoPath, method.name)
        : manualSearchOne(targetRepoPath, method.name);

      usages.push({
        symbolName: method.name,
        reason: method.reason,
        matches,
        matchCount: matches.length,
        backend,
      });
    }
  }

  return {
    targetPath: targetRepoPath,
    backend,
    scanned,
    usages,
    anyHits: usages.some((u) => u.matchCount > 0),
  };
}

/**
 * Pretty-print a scan result. Grouped by symbol, file:line beneath each.
 * Counts come first so the demo can see at a glance which symbols have
 * genuine exposure vs noise.
 */
export function formatScanResult(result: ScanResult): string {
  const out: string[] = [];

  out.push('');
  out.push('='.repeat(72));
  out.push(`USAGE SCAN: ${result.targetPath}`);
  out.push(`backend: ${result.backend}  |  scanned: ${result.scanned}`);
  out.push('='.repeat(72));

  if (!result.scanned) {
    out.push('');
    out.push('Target directory is missing or not readable.');
    out.push('Set RECEPTA_TARGET_PATH in .env to point at a real repo.');
    out.push('');
    out.push('='.repeat(72));
    return out.join('\n');
  }

  if (result.usages.length === 0) {
    out.push('');
    out.push('No symbols to scan.');
    out.push('');
    out.push('='.repeat(72));
    return out.join('\n');
  }

  const totalMatches = result.usages.reduce((sum, u) => sum + u.matchCount, 0);

  out.push('');
  out.push(`Scanned ${result.usages.length} symbol(s), ${totalMatches} total match(es).`);
  out.push('');

  for (const usage of result.usages) {
    out.push(`--- ${usage.symbolName} (${usage.matchCount} match${usage.matchCount === 1 ? '' : 'es'}) ---`);
    if (usage.reason) {
      out.push(`    reason: ${usage.reason}`);
    }
    if (usage.matches.length === 0) {
      out.push('    (no usages found)');
      out.push('');
      continue;
    }

    // Cap the per-symbol output so a generic name does not flood the console.
    // Showing the first 10 is enough to spot noise vs genuine usage; the full
    // count is preserved above so nothing is silently dropped.
    const SHOWN = 10;
    for (const match of usage.matches.slice(0, SHOWN)) {
      out.push(`    ${match.file}:${match.line}  ${match.code.trim()}`);
    }
    if (usage.matches.length > SHOWN) {
      out.push(`    ... and ${usage.matches.length - SHOWN} more match(es) for this symbol`);
    }
    out.push('');
  }

  out.push('='.repeat(72));
  return out.join('\n');
}