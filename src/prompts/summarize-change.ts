import type { ChangeData } from '../gather-changes';

/**
 * Prompt template for the breaking-change summarizer.
 *
 * Deliberately one readable template rather than scattered string concatenation
 * — the wording here is what the whole product stands on, and iterating on it
 * is a core day-3 activity. Keeping it as a function over ChangeData means
 * format changes don't require new string surgery.
 *
 * The instructions are weighted toward three things that historically trip up
 * naive LLM summaries of dependency upgrades:
 *   1. Reading release notes AND the type diff together. Treating either alone
 *      gives the maintainer the last word, which is exactly the silent-break
 *      failure mode DriftGuard exists to catch.
 *   2. Top-level exported symbol removals or renames are the strongest breaking
 *      signal. Nested inline-type property changes are weak evidence unless the
 *      release notes corroborate them.
 *   3. A discrepancy between what the release notes claim and what the type
 *      diff shows is itself a verdict — that is the product's core value, not
 *      a footnote.
 */

export interface BuildPromptOptions {
  /**
   * When true, append a follow-up instruction after the verdict that asks
   * the model to fix its previous non-JSON response. Used only on the retry
   * path so the user-facing first call stays clean.
   */
  retryForJson?: boolean;
}

const SYSTEM_INSTRUCTIONS = `You are a senior staff engineer reviewing an npm dependency upgrade.
Your job is to judge whether the upgrade is BREAKING and to name the
specific exports, methods, or options that are affected.

You have three sources of evidence:
  (1) the maintainer's GitHub Release notes for the new version,
  (2) the package's npm metadata for both versions,
  (3) a diff of the package's public type definitions between the two versions.

Read them together. Do not judge them in isolation. The release notes are
written by the maintainer and may downplay breakage; the type diff is the
ground truth for what the public API surface actually does. Trust each
source for what it is good at.

Heuristics:
  - Top-level exported symbols that are REMOVED or RENAMED are a STRONG
    breaking signal. They are not formatting noise.
  - RENAMED exports are breaking under any naming convention.
  - Nested inline-type property changes (e.g. a field that becomes visible
    only after a reflow of an inline type literal) are WEAK evidence. Treat
    them as noise unless release notes corroborate an intentional change.
  - If the release notes say "bug fixes" or "misc improvements" but the type
    diff shows removed public API surface, that mismatch is itself the most
    important finding. Call it out explicitly.
  - If the diff is "looks reformatted", trust the symbol list, not the line list.
  - When in doubt, set confidence to "medium" or "low" and explain why in the
    summary, rather than guessing "high".

Return ONLY a JSON object that matches this exact schema — no prose, no
markdown, no code fences, no commentary before or after:

IMPORTANT on 'affectedMethods[].name': this must be a real TypeScript-style
identifier (letters, digits, underscore, dollar sign — start with a letter,
underscore, or dollar). Do NOT put sentences, phrases like "all exported
symbols", or counts like "170 removed symbols" in this field. If a removal
spans many symbols, pick the highest-impact few (under 20) and put the count
in the 'summary' instead. Invalid names will be silently dropped downstream
and the user gets a worse report.

{
  "breaking": (boolean),
  "confidence": ("high" or "medium" or "low"),
  "affectedMethods": [
    { "name": "(export or method name)", "reason": "(one-sentence reason)" }
  ],
  "summary": "(one or two sentences for a PR body or a chat reply)",
  "discrepancyNote": "(string describing what release notes claim vs. what the diff shows, or null if the two agree)"
}

\`affectedMethods\` must be an array (use [] if none), never a string.
If you cannot produce valid JSON for any reason, return the literal string
"INVALID_JSON" so the caller can detect and retry.`;

/**
 * Render the gatherChangeData() result as the user message that goes with
 * the system instructions above. Sections are explicitly labeled so the
 * model can quote from them when justifying its verdict.
 */
export function buildPrompt(change: ChangeData, options: BuildPromptOptions = {}): {
  system: string;
  user: string;
} {
  const user: string[] = [];

  user.push(`DEPENDENCY UNDER REVIEW: ${change.packageName}`);
  user.push(`UPGRADE: ${change.oldVersion} -> ${change.newVersion}`);
  user.push('');

  // -- Source 1: release notes ---------------------------------------------
  user.push('=== SOURCE 1: GITHUB RELEASE NOTES (maintainer\'s account) ===');
  if (change.releaseNotes.found) {
    const notes = change.releaseNotes;
    user.push(`tag        : ${notes.tag}${notes.isPrerelease ? ' (prerelease)' : ''}`);
    user.push(`published  : ${notes.publishedAt ?? 'unknown'}`);
    user.push(`url        : ${notes.url}`);
    user.push('body       :');
    user.push(notes.body.trim());
  } else {
    user.push(`NOT AVAILABLE — ${change.releaseNotes.reason}`);
  }
  user.push('');

  // -- Source 2: npm metadata -----------------------------------------------
  user.push('=== SOURCE 2: NPM METADATA (package manifest) ===');
  const { old: oldMeta, new: newMeta, dependencyChanges } = change.npmMetadata;
  if (change.npmMetadata.error) {
    user.push(`partial — ${change.npmMetadata.error}`);
  }
  user.push(`${change.oldVersion.padEnd(10)} : ${describeMeta(oldMeta)}`);
  user.push(`${change.newVersion.padEnd(10)} : ${describeMeta(newMeta)}`);

  if (dependencyChanges) {
    user.push(`dependencies added    : ${dependencyChanges.added.join(', ') || '(none)'}`);
    user.push(`dependencies removed  : ${dependencyChanges.removed.join(', ') || '(none)'}`);
    user.push(`dependencies changed  : ${dependencyChanges.changed.join(', ') || '(none)'}`);
  } else {
    user.push('dependencies          : (could not diff — at least one manifest lookup failed)');
  }
  user.push('');

  // -- Source 3: type diff -------------------------------------------------
  user.push('=== SOURCE 3: TYPE / API SURFACE DIFF (ground truth on what changed) ===');
  if (change.typeDiff) {
    const diff = change.typeDiff;
    user.push(`file              : ${diff.path}  (via ${diff.source})`);
    user.push(`line churn        : +${diff.added.length} / -${diff.removed.length}`);
    if (diff.approximated) {
      user.push('APPROXIMATED      : changed region exceeded the exact-LCS limit');
    }
    if (diff.looksReformatted) {
      user.push('LOOKS REFORMATTED : line churn is high but symbol churn is low —');
      user.push('                    this release reflowed its type definitions. Trust');
      user.push('                    the symbol diff below, not the line diff.');
    }
    user.push('');
    user.push(`SYMBOLS REMOVED (${diff.symbolsRemoved.length}) — candidate breaking changes:`);
    user.push(diff.symbolsRemoved.length
      ? diff.symbolsRemoved.map((s) => `  - ${s}`).join('\n')
      : '  (none)');
    user.push('');
    user.push(`SYMBOLS ADDED (${diff.symbolsAdded.length}):`);
    user.push(diff.symbolsAdded.length
      ? diff.symbolsAdded.map((s) => `  + ${s}`).join('\n')
      : '  (none)');
  } else {
    user.push(`NOT AVAILABLE — ${change.typeDiffNote ?? 'no comparable file could be fetched'}`);
  }
  user.push('');

  // -- The actual ask -------------------------------------------------------
  user.push('=== VERDICT ===');
  if (options.retryForJson) {
    user.push('REMINDER: your previous response was not parseable JSON.');
    user.push('Return ONLY the JSON object described in the system instructions.');
    user.push('No prose, no markdown, no code fences. The JSON object must start with "{"');
    user.push('and end with "}" and contain every required field.');
  } else {
    user.push('Return the JSON verdict described in the system instructions.');
  }

  return { system: SYSTEM_INSTRUCTIONS, user: user.join('\n') };
}

function describeMeta(meta: { publishedAt: string | null; deprecated: string | null; dependencies: Record<string, string> } | null): string {
  if (!meta) {
    return 'lookup failed';
  }
  const parts = [
    `published ${meta.publishedAt ?? 'unknown'}`,
    `${Object.keys(meta.dependencies).length} deps`,
  ];
  if (meta.deprecated) {
    parts.push(`DEPRECATED: ${meta.deprecated}`);
  }
  return parts.join(' | ');
}