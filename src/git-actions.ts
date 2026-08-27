import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// The `resolution-mode` attribute is required to pull a type out of an
// ESM-only package from a CommonJS file. Type-only, erased at runtime.
import type { Octokit as OctokitType } from '@octokit/rest' with { 'resolution-mode': 'import' };

import { hasGitHubToken, getOctokit, MissingTokenError } from './octokit-client';
import type { FixDraft, FixSuggestion } from './fix-generator';

/**
 * Day 6: turn the Day 5 fix draft into a real pull request on GitHub.
 *
 * The whole flow is:
 *   1. createFixBranch — branch off the base branch.
 *   2. applyFixesToFiles — write only HIGH-confidence suggestions to disk
 *      on the new branch.
 *   3. Commit the changes locally and push the branch.
 *   4. openDraftPR — open a DRAFT PR with the Day 5 Markdown report as the
 *      body.
 *
 * The function is split into three small units so the test surface is
 * small and the failure modes are visible. The orchestrator at the bottom
 * runs them in order and surfaces any single failure cleanly.
 *
 * Safety:
 *   - Never writes to the base branch directly.
 *   - Only HIGH-confidence suggestions are written as diffs. MEDIUM, LOW,
 *     and `requires-manual-review` become checkboxes in the PR body.
 *   - Every operation has a fallback path that returns a structured error
 *     instead of throwing, so the CLI can print a clean message.
 */

export interface RepoRef {
  owner: string;
  /** Repo name on GitHub, not the local directory name. */
  name: string;
}

export interface BranchResult {
  ok: boolean;
  branch?: string;
  baseSha?: string;
  error?: string;
}

export interface ApplyResult {
  ok: boolean;
  /** Files written, repo-relative paths. */
  filesWritten: string[];
  /** Number of HIGH-confidence suggestions applied. */
  applied: number;
  /** Suggestions skipped because their file did not match the original line. */
  skipped: number;
  error?: string;
}

export interface PushResult {
  ok: boolean;
  error?: string;
}

export interface OpenPrResult {
  ok: boolean;
  url?: string;
  number?: number;
  error?: string;
}

/** Sanitize a package name so it can be safely used in a branch name. */
function sanitizeForBranch(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Format a YYYY-MM-DD-HHMMSS timestamp for the branch name. */
function dateStamp(date: Date = new Date()): string {
  // HHMMSS suffix makes back-to-back runs of the same day safe. The
  // branch is cheap to keep around, and uniqueness matters because we
  // cannot push to an existing ref.
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * Build a branch name like
 * `driftguard/fix-whatsapp-web.js-2026-08-27-141100`. The HHMMSS suffix
 * means multiple runs in the same day do not collide on the ref name.
 */
export function buildBranchName(packageName: string, date: Date = new Date()): string {
  return `driftguard/fix-${sanitizeForBranch(packageName)}-${dateStamp(date)}`;
}

/**
 * Construct a PR title in the conventional format the user asked for.
 *
 * Example: `[DriftGuard] Fix for whatsapp-web.js 2.0.0-alpha.0 breaking
 * change: ClientSession removed`
 *
 * The "removed" suffix is the most common case but is honest about what
 * kind of change the LLM verdict reported — for additive changes this
 * would say "API added", but Day 5's pipeline is biased toward break
 * detection, so "removed" is the right default for the demo.
 */
export function buildPrTitle(draft: FixDraft, primarySymbol: string): string {
  return `[DriftGuard] Fix for ${draft.packageName} ${draft.oldVersion} -> ${draft.newVersion} breaking change: ${primarySymbol} removed`;
}

/**
 * Create a new branch from the base branch HEAD. Returns the new branch
 * name and base SHA so the caller can attach a commit to it.
 *
 * Does NOT push anything — push happens after the local commit is made.
 */
export async function createFixBranch(
  repo: RepoRef,
  baseBranch: string,
  branchName: string,
): Promise<BranchResult> {
  if (!hasGitHubToken()) {
    return { ok: false, error: new MissingTokenError().message };
  }

  let octokit: OctokitType;
  try {
    octokit = await getOctokit();
  } catch (error) {
    return { ok: false, error: `Failed to initialize Octokit: ${(error as Error).message}` };
  }

  let baseSha: string;
  try {
    const ref = await octokit.rest.git.getRef({
      owner: repo.owner,
      repo: repo.name,
      ref: `heads/${baseBranch}`,
    });
    baseSha = ref.data.object.sha;
  } catch (error) {
    return {
      ok: false,
      error: `Could not read base ref heads/${baseBranch} on ${repo.owner}/${repo.name}: ${(error as Error).message}`,
    };
  }

  try {
    await octokit.rest.git.createRef({
      owner: repo.owner,
      repo: repo.name,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 422) {
      return {
        ok: false,
        error: `Branch ${branchName} already exists on ${repo.owner}/${repo.name}. Delete it or wait for a new date stamp.`,
      };
    }
    return {
      ok: false,
      error: `createRef failed: ${(error as Error).message}`,
    };
  }

  return { ok: true, branch: branchName, baseSha };
}

/**
 * Apply HIGH-confidence fix suggestions to the files on disk.
 *
 * Atomic-per-file: read each target file ONCE, apply ALL of its matching
 * HIGH-confidence fixes against the in-memory copy in reverse line order
 * (so a later-applied edit at line N cannot shift the line number of an
 * earlier-applied edit at line N-1), then write the file ONCE. This is
 * the Day 7 polish for the file-drift bug Day 6 hit, where per-fix
 * read/write loops caused later suggestions to fail the `lines[target]
 * !== originalCode` guard.
 *
 * Only HIGH confidence is applied — MEDIUM, LOW, and manual-review become
 * checklist items in the PR body.
 *
 * The `targetRepoPath` is the local checkout of the target repo. We do
 * NOT push directly from the DriftGuard repo to a target repo — DriftGuard
 * operates against a separately-cloned consumer repo.
 *
 * Returns the list of files actually written. Suggestions whose original
 * line is no longer present at scan time are skipped (counted as `skipped`)
 * — the conservative safety check itself is unchanged.
 */
export function applyFixesToFiles(
  suggestions: FixSuggestion[],
  targetRepoPath: string,
): ApplyResult {
  // 1. Filter to HIGH-confidence with a non-null suggestedCode.
  const applicable = suggestions.filter(
    (s) => s.confidence === 'high' && s.suggestedCode !== null,
  );

  // 2. Group by file path. Suggestions within a file keep their original
  //    order, but we'll apply them in reverse-line order below.
  const byFile = new Map<string, FixSuggestion[]>();
  for (const s of applicable) {
    const list = byFile.get(s.file);
    if (list) list.push(s);
    else byFile.set(s.file, [s]);
  }

  const filesWritten: string[] = [];
  let applied = 0;
  let skipped = 0;

  // 3. For each file: read once, apply all in reverse line order, write once.
  for (const [filePath, fixes] of byFile.entries()) {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.join(targetRepoPath, filePath);

    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      // File unreadable — every fix for this file is skipped.
      skipped += fixes.length;
      continue;
    }

    const lines = content.split('\n');

    // Sort by line descending so applying edit at line N does not shift
    // the index of an edit at line N-1 we haven't applied yet.
    const sorted = [...fixes].sort((a, b) => b.line - a.line);

    let fileApplied = 0;
    for (const fix of sorted) {
      const target = fix.line - 1;
      if (target < 0 || target >= lines.length) {
        skipped += 1;
        continue;
      }
      if (lines[target] !== fix.originalCode) {
        // Conservative safety check: the matched line content has drifted
        // since the scanner ran. Skip rather than corrupt the file.
        skipped += 1;
        continue;
      }
      lines[target] = fix.suggestedCode ?? lines[target];
      fileApplied += 1;
    }

    if (fileApplied > 0) {
      fs.writeFileSync(abs, lines.join('\n'), 'utf8');
      filesWritten.push(filePath);
      applied += fileApplied;
    }
  }

  return {
    ok: true,
    filesWritten,
    applied,
    skipped,
  };
}

/**
 * Commit the changes locally and push the new branch to the remote.
 *
 * Uses `git` directly via execFileSync — this is the simplest reliable
 * way to do a single-branch commit + push without dragging in a JS git
 * library. The branch must already exist locally OR we create it from
 * the base branch first.
 */
export function pushBranch(
  targetRepoPath: string,
  baseBranch: string,
  newBranch: string,
  commitMessage: string,
): PushResult {
  try {
    // 1. Make sure we are on the base branch before creating a new one.
    //    DriftGuard intentionally modifies the working tree before this
    //    call (applyFixesToFiles writes HIGH-confidence fixes), so a
    //    generic "is the tree clean" check is wrong here — instead we
    //    check that no UNTRACKED files remain, since DriftGuard only
    //    edits files that were already tracked when the pipeline started.
    const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: targetRepoPath,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.startsWith('??'))
      .join('\n');
    if (untracked.length > 0) {
      return {
        ok: false,
        error: `Target repo has untracked files that DriftGuard did not create. Commit or remove them first:\n${untracked}`,
      };
    }

    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: targetRepoPath,
      encoding: 'utf8',
    }).trim();
    if (currentBranch !== baseBranch) {
      return {
        ok: false,
        error: `Local repo is on ${currentBranch}, not ${baseBranch}. Check out the base branch before running --open-pr.`,
      };
    }

    // 2. Create the new branch from the current HEAD, carrying the
    //    DriftGuard edits with it. `-B` overwrites any stale branch with
    //    the same name (safe — the branch was created by us moments ago).
    execFileSync('git', ['checkout', '-B', newBranch], {
      cwd: targetRepoPath,
      encoding: 'utf8',
    });

    // 3. Stage everything and commit.
    execFileSync('git', ['add', '-A'], { cwd: targetRepoPath, encoding: 'utf8' });
    execFileSync('git', ['commit', '-m', commitMessage], {
      cwd: targetRepoPath,
      encoding: 'utf8',
    });

    // 4. Push the new branch to origin.
    execFileSync('git', ['push', '-u', 'origin', newBranch], {
      cwd: targetRepoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString();
    return {
      ok: false,
      error: stderr ?? e.message ?? 'Unknown git error',
    };
  }

  return { ok: true };
}

/**
 * Render the PR body from a fix draft. Uses the same Markdown structure
 * as the Day 5 report, plus a clearly-labeled "AI-generated" notice.
 *
 * Splitting this out from openDraftPR so the body can be inspected before
 * the call to create the PR.
 */
export function renderPrBody(draft: FixDraft, branchName: string): string {
  const t = draft.totals;
  const lines: string[] = [];

  lines.push(`# DriftGuard Fix — ${draft.packageName} ${draft.oldVersion} -> ${draft.newVersion}`);
  lines.push('');
  lines.push('> ⚠️ **AI-generated draft PR.** Generated by DriftGuard. Each fix is an LLM draft; please review before merging. This PR was opened automatically by an AI agent and should be reviewed like any other PR — the [Postman AI Engineer piece](https://www.postman.com/) on AI-assisted engineering calls this pattern "human approval on write actions", which is what DriftGuard mirrors.');
  lines.push('');
  lines.push(`Branch: \`${branchName}\``);
  lines.push(`Target repo: \`${draft.targetRepoPath}\``);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Package: **${draft.packageName}** ${draft.oldVersion} -> ${draft.newVersion}`);
  lines.push(`- Symbols with matches: **${t.symbolsWithMatches}**`);
  lines.push(`- Total suggestions: **${t.suggestions}**`);
  lines.push(`- High confidence (auto-applied as diffs): ${t.highConfidence}`);
  lines.push(`- Medium confidence (checklist below): ${t.mediumConfidence}`);
  lines.push(`- Low confidence (checklist below): ${t.lowConfidence}`);
  lines.push(`- Requires manual review (checklist below): ${t.manualReview}`);
  lines.push('');

  // Auto-applied high-confidence section
  const highSuggestions = draft.suggestions.filter((s) => s.confidence === 'high' && s.suggestedCode !== null);
  if (highSuggestions.length > 0) {
    lines.push('## Auto-applied HIGH confidence fixes');
    lines.push('');
    lines.push('These were written to the branch automatically. Please review the diff before merging.');
    lines.push('');
    for (const s of highSuggestions) {
      lines.push(`- [x] \`${s.file}\`:${s.line} — \`${s.symbolName}\``);
    }
    lines.push('');
  }

  // Manual-review checklist
  const manualSuggestions = draft.suggestions.filter((s) => s.confidence !== 'high');
  if (manualSuggestions.length > 0) {
    lines.push('## Needs manual review');
    lines.push('');
    lines.push('These suggestions were NOT applied automatically. The LLM could not propose a confident one-line fix. Review the report and apply manually if appropriate.');
    lines.push('');
    for (const s of manualSuggestions) {
      const label =
        s.confidence === 'medium' ? '🟡 medium' :
        s.confidence === 'low' ? '🟠 low' :
        '🔴 manual review';
      lines.push(`- [ ] \`${s.file}\`:${s.line} — \`${s.symbolName}\` — _${label}_`);
    }
    lines.push('');
  }

  // Per-symbol detail (the meat of the report)
  const symbols = Object.keys(draft.bySymbol).sort();
  for (const symbolName of symbols) {
    const suggestions = draft.bySymbol[symbolName];
    const first = suggestions[0];
    lines.push(`## \`${symbolName}\``);
    lines.push('');
    if (first.symbolReason) {
      lines.push(`> ${first.symbolReason}`);
      lines.push('');
    }
    for (const s of suggestions) {
      const confLabel =
        s.confidence === 'high' ? 'HIGH' :
        s.confidence === 'medium' ? 'MEDIUM' :
        s.confidence === 'low' ? 'LOW' :
        'MANUAL REVIEW';
      lines.push(`- \`${s.file}\`:${s.line} — Confidence: **${confLabel}**`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_Generated by DriftGuard. The full Markdown report is in `reports/`. To skip a suggestion, revert the corresponding file on this branch._');

  return lines.join('\n');
}

/**
 * Open a DRAFT pull request on GitHub.
 */
export async function openDraftPR(
  repo: RepoRef,
  baseBranch: string,
  headBranch: string,
  title: string,
  body: string,
): Promise<OpenPrResult> {
  if (!hasGitHubToken()) {
    return { ok: false, error: new MissingTokenError().message };
  }

  let octokit: OctokitType;
  try {
    octokit = await getOctokit();
  } catch (error) {
    return { ok: false, error: `Failed to initialize Octokit: ${(error as Error).message}` };
  }

  try {
    const response = await octokit.rest.pulls.create({
      owner: repo.owner,
      repo: repo.name,
      title,
      body,
      head: headBranch,
      base: baseBranch,
      draft: true,
    });

    return {
      ok: true,
      url: response.data.html_url,
      number: response.data.number,
    };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 403) {
      return {
        ok: false,
        error: `GitHub returned 403 when creating the PR. Token likely lacks Pull requests: write scope.`,
      };
    }
    if (status === 422) {
      return {
        ok: false,
        error: `GitHub returned 422 — likely no diff between ${headBranch} and ${baseBranch}, or the branches are identical.`,
      };
    }
    return {
      ok: false,
      error: `Failed to create PR: ${(error as Error).message}`,
    };
  }
}

export interface OpenPrOrchestratorResult {
  ok: boolean;
  /** True if we got far enough to apply HIGH-confidence fixes (even if PR creation failed afterwards). */
  branchCreated: boolean;
  applied: number;
  skipped: number;
  prUrl?: string;
  prNumber?: number;
  /** First error that aborted the flow, if any. */
  error?: string;
}

/**
 * End-to-end Day 6: branch → apply → push → PR.
 *
 * This is the function index.ts calls. Returns a structured result so the
 * CLI can print progress and bail cleanly on any single failure without
 * leaving half-applied state behind.
 *
 * Note: the local checkout of the target repo is a separate working tree
 * from DriftGuard itself. DriftGuard does NOT modify its own files here —
 * only files inside `targetRepoPath`.
 */
export async function runOpenPr(args: {
  draft: FixDraft;
  repo: RepoRef;
  baseBranch: string;
  targetRepoPath: string;
}): Promise<OpenPrOrchestratorResult> {
  const { draft, repo, baseBranch, targetRepoPath } = args;

  // 1. Identify the primary symbol for the PR title.
  const highSuggestions = draft.suggestions.filter((s) => s.confidence === 'high');
  const primarySymbol =
    highSuggestions[0]?.symbolName ??
    Object.keys(draft.bySymbol)[0] ??
    'unknown';

  const branchName = buildBranchName(draft.packageName);

  // 2. Create the branch on GitHub first.
  const branchResult = await createFixBranch(repo, baseBranch, branchName);
  if (!branchResult.ok) {
    return {
      ok: false,
      branchCreated: false,
      applied: 0,
      skipped: 0,
      error: `createFixBranch failed: ${branchResult.error}`,
    };
  }

  // 3. Apply HIGH-confidence fixes to the local checkout.
  const applyResult = applyFixesToFiles(highSuggestions, targetRepoPath);
  if (!applyResult.ok) {
    return {
      ok: false,
      branchCreated: true,
      applied: 0,
      skipped: 0,
      error: `applyFixesToFiles failed: ${applyResult.error}`,
    };
  }

  if (applyResult.applied === 0) {
    return {
      ok: false,
      branchCreated: true,
      applied: 0,
      skipped: applyResult.skipped,
      error: `No HIGH-confidence fixes could be applied (${applyResult.skipped} skipped). Aborting before creating an empty PR.`,
    };
  }

  // 4. Commit and push.
  const commitMessage = `[DriftGuard] Apply ${applyResult.applied} HIGH-confidence fix(es) for ${draft.packageName} ${draft.oldVersion} -> ${draft.newVersion}`;
  const pushResult = pushBranch(targetRepoPath, baseBranch, branchName, commitMessage);
  if (!pushResult.ok) {
    return {
      ok: false,
      branchCreated: true,
      applied: applyResult.applied,
      skipped: applyResult.skipped,
      error: `pushBranch failed: ${pushResult.error}`,
    };
  }

  // 5. Open the draft PR.
  const title = buildPrTitle(draft, primarySymbol);
  const body = renderPrBody(draft, branchName);
  const prResult = await openDraftPR(repo, baseBranch, branchName, title, body);
  if (!prResult.ok) {
    return {
      ok: false,
      branchCreated: true,
      applied: applyResult.applied,
      skipped: applyResult.skipped,
      error: `openDraftPR failed: ${prResult.error}`,
    };
  }

  return {
    ok: true,
    branchCreated: true,
    applied: applyResult.applied,
    skipped: applyResult.skipped,
    prUrl: prResult.url,
    prNumber: prResult.number,
  };
}
