import { getReleaseNotes, type ReleaseNotesResult } from './changelog';
import { getPackageMetadata, diffDependencies, type PackageMetadata } from './npm-metadata';
import { diffTypes, type TypeDiff } from './type-diff';

/**
 * Collects everything known about what changed between two published versions.
 *
 * This is the raw-material stage. Nothing here interprets or judges — it
 * gathers three independent views of the same upgrade so that Day 3's LLM pass
 * has corroborating evidence rather than a single source to take on faith:
 *
 *   1. releaseNotes — what the maintainer said changed
 *   2. npmMetadata  — what the package manifest says changed (deps, deprecation)
 *   3. typeDiff     — what the public API surface actually did
 *
 * The three disagreeing is a signal, not a bug. A method vanishing from the
 * type diff while the release notes say "bug fixes" is exactly the silent
 * break this project exists to catch.
 */

export interface NpmMetadataPair {
  old: PackageMetadata | null;
  new: PackageMetadata | null;
  /** Null when either side failed to load. */
  dependencyChanges: { added: string[]; removed: string[]; changed: string[] } | null;
  /** Populated when a lookup failed, so a partial result is still diagnosable. */
  error?: string;
}

export interface ChangeData {
  packageName: string;
  oldVersion: string;
  newVersion: string;
  releaseNotes: ReleaseNotesResult;
  npmMetadata: NpmMetadataPair;
  typeDiff: TypeDiff | null;
  /** Why typeDiff is null, when it is. */
  typeDiffNote?: string;
}

/**
 * Gather release notes, npm metadata and a type diff for an upgrade.
 *
 * All three run concurrently, and each is allowed to fail independently — a
 * missing type diff should not cost you the release notes.
 */
export async function gatherChangeData(
  packageName: string,
  oldVersion: string,
  newVersion: string,
): Promise<ChangeData> {
  let typeDiffNote: string | undefined;

  const [notesResult, oldMetaResult, newMetaResult, diffResult] = await Promise.allSettled([
    getReleaseNotes(packageName, newVersion),
    getPackageMetadata(packageName, oldVersion),
    getPackageMetadata(packageName, newVersion),
    diffTypes(packageName, oldVersion, newVersion, {
      onUnavailable: (reason) => {
        typeDiffNote = reason;
      },
    }),
  ]);

  const releaseNotes: ReleaseNotesResult =
    notesResult.status === 'fulfilled'
      ? notesResult.value
      : { found: false, reason: `Release lookup threw: ${String(notesResult.reason)}` };

  const oldMeta = oldMetaResult.status === 'fulfilled' ? oldMetaResult.value : null;
  const newMeta = newMetaResult.status === 'fulfilled' ? newMetaResult.value : null;

  const metadataErrors = [oldMetaResult, newMetaResult]
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as Error).message);

  const npmMetadata: NpmMetadataPair = {
    old: oldMeta,
    new: newMeta,
    dependencyChanges:
      oldMeta && newMeta ? diffDependencies(oldMeta.dependencies, newMeta.dependencies) : null,
    ...(metadataErrors.length > 0 ? { error: metadataErrors.join('; ') } : {}),
  };

  const typeDiff = diffResult.status === 'fulfilled' ? diffResult.value : null;
  if (diffResult.status === 'rejected') {
    typeDiffNote = `Type diff threw: ${String(diffResult.reason)}`;
  }

  return {
    packageName,
    oldVersion,
    newVersion,
    releaseNotes,
    npmMetadata,
    typeDiff,
    ...(typeDiffNote ? { typeDiffNote } : {}),
  };
}

export interface FormatOptions {
  /** Truncate the release body past this many characters. 0 disables truncation. */
  maxReleaseBodyChars?: number;
  /** Truncate the unified diff past this many lines. 0 disables truncation. */
  maxDiffLines?: number;
}

function heading(title: string): string {
  return `\n${title}\n${'-'.repeat(title.length)}`;
}

function truncate(text: string, limit: number, unit: 'chars' | 'lines'): string {
  if (limit <= 0) {
    return text;
  }

  if (unit === 'chars') {
    return text.length <= limit
      ? text
      : `${text.slice(0, limit)}\n... [truncated ${text.length - limit} more characters]`;
  }

  const lines = text.split('\n');
  return lines.length <= limit
    ? text
    : `${lines.slice(0, limit).join('\n')}\n... [truncated ${lines.length - limit} more lines]`;
}

/** Render gathered change data for the console. */
export function formatChangeData(data: ChangeData, options: FormatOptions = {}): string {
  const { maxReleaseBodyChars = 0, maxDiffLines = 60 } = options;
  const out: string[] = [];

  out.push('');
  out.push('='.repeat(72));
  out.push(`CHANGE DATA: ${data.packageName}  ${data.oldVersion} → ${data.newVersion}`);
  out.push('='.repeat(72));

  // --- 1. Release notes -----------------------------------------------------
  out.push(heading('1. GITHUB RELEASE NOTES'));
  if (data.releaseNotes.found) {
    const notes = data.releaseNotes;
    out.push(`repo      : ${notes.repo.owner}/${notes.repo.repo}`);
    out.push(`tag       : ${notes.tag}${notes.isPrerelease ? '  (prerelease)' : ''}`);
    out.push(`title     : ${notes.name}`);
    out.push(`published : ${notes.publishedAt ?? 'unknown'}`);
    out.push(`url       : ${notes.url}`);
    out.push(`body      : ${notes.body.length} characters`);
    out.push('');
    out.push(truncate(notes.body.trim(), maxReleaseBodyChars, 'chars'));
  } else {
    out.push(`NOT AVAILABLE — ${data.releaseNotes.reason}`);
    if (data.releaseNotes.triedTags) {
      out.push(`tags tried: ${data.releaseNotes.triedTags.join(', ')}`);
    }
  }

  // --- 2. npm metadata ------------------------------------------------------
  out.push(heading('2. NPM METADATA'));
  const { old: oldMeta, new: newMeta, dependencyChanges } = data.npmMetadata;

  if (data.npmMetadata.error) {
    out.push(`partial — ${data.npmMetadata.error}`);
  }

  for (const [label, meta] of [
    [data.oldVersion, oldMeta],
    [data.newVersion, newMeta],
  ] as const) {
    if (!meta) {
      out.push(`${label.padEnd(10)} : lookup failed`);
      continue;
    }
    out.push(
      `${label.padEnd(10)} : published ${meta.publishedAt ?? 'unknown'}` +
        `  |  ${Object.keys(meta.dependencies).length} deps` +
        `  |  ${meta.deprecated ? `DEPRECATED: ${meta.deprecated}` : 'not deprecated'}`,
    );
  }

  if (dependencyChanges) {
    const { added, removed, changed } = dependencyChanges;
    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      out.push('dependencies: unchanged');
    } else {
      if (added.length) out.push(`dependencies added   : ${added.join(', ')}`);
      if (removed.length) out.push(`dependencies removed : ${removed.join(', ')}`);
      if (changed.length) out.push(`dependencies changed : ${changed.join(', ')}`);
    }
  }

  // --- 3. Type diff ---------------------------------------------------------
  out.push(heading('3. TYPE / API SURFACE DIFF'));
  if (data.typeDiff) {
    const diff = data.typeDiff;
    out.push(`file    : ${diff.path}  (via ${diff.source})`);
    out.push(`lines   : ${diff.oldLineCount} → ${diff.newLineCount}`);
    out.push(`changed : +${diff.added.length} / -${diff.removed.length} lines`);
    if (diff.approximated) {
      out.push('note    : diff approximated — changed region exceeded the exact-LCS limit');
    }
    if (diff.looksReformatted) {
      out.push(
        'note    : heavy line churn with almost no symbol churn — this release',
      );
      out.push(
        '          REFORMATTED its type definitions. Trust the symbol diff below,',
      );
      out.push('          not the line diff.');
    }

    // Symbols first: this is the signal Day 3 needs, and unlike the line diff
    // it survives a release that reflows its own formatting.
    out.push('');
    out.push(`SYMBOLS REMOVED (${diff.symbolsRemoved.length}) — candidate breaking changes:`);
    out.push(diff.symbolsRemoved.length ? `  ${diff.symbolsRemoved.join(', ')}` : '  (none)');
    out.push('');
    out.push(`SYMBOLS ADDED (${diff.symbolsAdded.length}):`);
    out.push(diff.symbolsAdded.length ? `  ${diff.symbolsAdded.join(', ')}` : '  (none)');

    out.push('');
    out.push('LINE DIFF:');
    out.push(truncate(diff.unifiedDiff, maxDiffLines, 'lines'));
  } else {
    out.push(`NOT AVAILABLE — ${data.typeDiffNote ?? 'no comparable file could be fetched'}`);
  }

  out.push('');
  out.push('='.repeat(72));

  return out.join('\n');
}
