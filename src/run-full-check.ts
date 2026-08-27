import { randomUUID } from 'crypto';

import {
  gatherChangeData,
  getVerdictForChange,
  findUsages,
  draftFixesForChange,
  runOpenPr,
  saveReport,
  type ChangeData,
  type VerdictResult,
  type ScanResult,
  type FixDraft,
  type OpenPrOrchestratorResult,
} from './engine';
import type { RepoRef } from './git-actions';

/**
 * Phase 1 — single entry point that drives the full DriftGuard pipeline.
 *
 * Used by:
 *   - the CLI wrapper (`src/index.ts`), which prints results to stdout
 *   - the new Express server (`apps/api/src/server.ts`), which returns
 *     them as JSON to the dashboard
 *
 * Pure orchestration: this file does not read `process.argv` or call
 * `console.log`. It sequences existing engine functions and packages their
 * outputs into a single structured `RunFullCheckResult`.
 */

export interface RunFullCheckPrOptions {
  owner: string;
  repo: string;
  baseBranch: string;
}

export interface RunFullCheckArgs {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** Path to the consumer repo to scan for usages and (optionally) write the PR into. */
  targetRepoPath: string;
  /** When provided, the pipeline will draft fixes and open a draft PR against this repo. */
  prOptions?: RunFullCheckPrOptions;
  /** Phase 2: when provided, use the GitHub App installation token for PR creation. */
  installationId?: number;
  /** Optional model override; defaults to whatever the engine picks. */
  model?: string;
}

/** Shape returned to API / CLI for one full check. */
export interface RunFullCheckResult {
  ok: boolean;
  /** Server-generated unique id; stable across the JSONL history row and any follow-up reads. */
  runId: string;
  startedAt: string;
  finishedAt: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** Raw change evidence — release notes, npm metadata, type diff. */
  changeData: ChangeData;
  /** LLM verdict on whether the upgrade is breaking. */
  verdict: VerdictResult;
  /** Scan results when the verdict was breaking AND a target repo path was given. Null otherwise. */
  scan: ScanResult | null;
  /** Per-match fix suggestions when scan produced hits. Null otherwise. */
  draft: FixDraft | null;
  /** Repo-relative or absolute path to the saved Markdown report. Null if no draft was generated. */
  reportPath: string | null;
  /** PR creation outcome when prOptions were provided. Null otherwise. */
  pr: OpenPrOrchestratorResult | null;
  /** First error that aborted the pipeline (if any). Other stages still report their own state. */
  error?: string;
}

function hasApiKey(): boolean {
  const key = process.env.MINIMAX_API_KEY?.trim();
  return Boolean(key) && key !== 'your_minimax_api_key_here';
}

/**
 * Run the full DriftGuard check pipeline for one (package, from, to) triple.
 *
 * Stages (all best-effort — a failure at any stage returns a structured
 * `RunFullCheckResult` with `ok: false` and an `error` field, but still
 * populates earlier-stage outputs so the caller can show progress):
 *
 *   1. gatherChangeData        — release notes, npm metadata, type diff
 *   2. getVerdictForChange     — LLM verdict (breaking? confidence?)
 *   3. findUsages              — only if verdict says breaking AND target repo given
 *   4. draftFixesForChange     — only if scan found real usages
 *   5. runOpenPr               — only if prOptions given AND draft has ≥1 HIGH fix
 *   6. saveReport              — only if a draft was generated
 */
export async function runFullCheck(args: RunFullCheckArgs): Promise<RunFullCheckResult> {
  const runId = randomUUID();
  const startedAt = new Date();
  const { packageName, fromVersion, toVersion, targetRepoPath, prOptions, installationId, model } = args;

  // Initialize empty result so partial failures still produce something to log.
  let changeData: ChangeData = {
    packageName,
    oldVersion: fromVersion,
    newVersion: toVersion,
    releaseNotes: { found: false, reason: 'not yet run' },
    npmMetadata: { old: null, new: null, dependencyChanges: null },
    typeDiff: null,
    typeDiffNote: 'not yet run',
  };
  let verdict: VerdictResult = {
    ok: false,
    error: 'not yet run',
    latencyMs: 0,
    totalTokens: 0,
    retried: false,
    model: model ?? 'unknown',
  };
  let scan: ScanResult | null = null;
  let draft: FixDraft | null = null;
  let pr: OpenPrOrchestratorResult | null = null;
  let reportPath: string | null = null;
  let ok = true;
  let error: string | undefined;

  // ---- Stage 1: gather raw change evidence ------------------------------
  try {
    changeData = await gatherChangeData(packageName, fromVersion, toVersion);
  } catch (e) {
    ok = false;
    error = `gatherChangeData failed: ${(e as Error).message}`;
    return finalize();
  }

  // ---- Stage 2: LLM verdict ---------------------------------------------
  if (!hasApiKey()) {
    ok = false;
    error = 'MINIMAX_API_KEY is not set — cannot call the LLM.';
    return finalize();
  }

  try {
    verdict = await getVerdictForChange(changeData, model ? { model } : {});
  } catch (e) {
    ok = false;
    error = `getVerdictForChange threw: ${(e as Error).message}`;
    return finalize();
  }

  if (!verdict.ok) {
    // Verdict is structured; surface its error but still proceed with empty
    // scan/draft so the run-history row records what happened.
    ok = false;
    error = `LLM verdict unavailable: ${verdict.error}`;
    return finalize();
  }

  // ---- Stage 3: scan the target repo ------------------------------------
  const verdictIsBreaking = verdict.verdict.breaking;
  if (!verdictIsBreaking || !targetRepoPath) {
    return finalize();
  }

  try {
    scan = await findUsages(verdict.verdict.affectedMethods, targetRepoPath);
  } catch (e) {
    ok = false;
    error = `findUsages threw: ${(e as Error).message}`;
    return finalize();
  }

  const symbolsWithHits = scan.usages.filter((u) => u.matchCount > 0);
  if (symbolsWithHits.length === 0) {
    return finalize();
  }

  // ---- Stage 4: draft per-match fixes -----------------------------------
  try {
    draft = await draftFixesForChange(packageName, fromVersion, toVersion, targetRepoPath, {
      ...(model ? { model } : {}),
    });
  } catch (e) {
    ok = false;
    error = `draftFixesForChange threw: ${(e as Error).message}`;
    return finalize();
  }

  // ---- Stage 5: save the Markdown report --------------------------------
  try {
    reportPath = saveReport(draft);
  } catch (e) {
    // A failed report save should not lose the draft — record it and move on.
    error = `saveReport threw: ${(e as Error).message}`;
  }

  // ---- Stage 6: open a draft PR (only if asked AND there's ≥1 HIGH fix) --
  if (prOptions && draft.totals.highConfidence > 0) {
    const repo: RepoRef = { owner: prOptions.owner, name: prOptions.repo };
    try {
      pr = await runOpenPr({
        draft,
        repo,
        baseBranch: prOptions.baseBranch,
        targetRepoPath,
        ...(installationId !== undefined ? { installationId } : {}),
      });
      if (!pr.ok) {
        // PR failure is a partial failure — the run still happened.
        ok = false;
        error = `runOpenPr failed: ${pr.error ?? 'unknown'}`;
      }
    } catch (e) {
      ok = false;
      error = `runOpenPr threw: ${(e as Error).message}`;
    }
  }

  return finalize();

  function finalize(): RunFullCheckResult {
    const finishedAt = new Date();
    return {
      ok,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      packageName,
      fromVersion,
      toVersion,
      changeData,
      verdict,
      scan,
      draft,
      reportPath,
      pr,
      ...(error ? { error } : {}),
    };
  }
}