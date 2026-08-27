import * as fs from 'fs';
import * as path from 'path';

import type { RunFullCheckResult } from './run-full-check';

/**
 * Phase 1 — append-only run history on a JSONL file.
 *
 * One JSON object per run, one per line, under `data/run-history.jsonl`.
 * The full file is read on every `listRuns()` call — fine for low volume,
 * would need caching if we ever cared about scale.
 *
 * The on-disk row strips the heaviest fields (the full fix suggestions
 * list, every per-match code context, the unified type diff body) so a
 * single line stays small. The full report and original result are still
 * available on disk under `reports/` and the original JSON is reconstructible
 * from the line for any single row that needs it.
 */

const DATA_DIR = 'data';
const HISTORY_FILE = path.join(DATA_DIR, 'run-history.jsonl');

/**
 * Shape persisted to disk. Mirrors `RunFullCheckResult` but with the
 * heaviest nested fields replaced by counts / paths so the file stays
 * inspectable and the JSONL stays under a few KB per row.
 */
export interface RunHistoryEntry {
  runId: string;
  startedAt: string;
  finishedAt: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  ok: boolean;
  verdict: {
    breaking: boolean | null;
    confidence: 'high' | 'medium' | 'low' | null;
    summary: string | null;
    error: string | null;
    affectedSymbols: number;
    retried: boolean;
    latencyMs: number;
    totalTokens: number;
    model: string;
  };
  scan: {
    targetPath: string;
    backend: 'ripgrep' | 'manual-walker';
    scanned: boolean;
    symbolsWithHits: number;
    totalMatches: number;
  } | null;
  draft: {
    symbolsWithMatches: number;
    suggestions: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
    manualReview: number;
    errors: number;
  } | null;
  reportPath: string | null;
  pr: {
    ok: boolean;
    branchCreated: boolean;
    applied: number;
    skipped: number;
    prUrl: string | null;
    prNumber: number | null;
    error: string | null;
  } | null;
  error: string | null;
}

/**
 * Reduce a `RunFullCheckResult` to the lightweight `RunHistoryEntry` shape.
 * Pure — no I/O.
 */
export function toRunHistoryEntry(result: RunFullCheckResult): RunHistoryEntry {
  const v = result.verdict;
  const verdictSummary = v.ok
    ? {
        breaking: v.verdict.breaking,
        confidence: v.verdict.confidence,
        summary: v.verdict.summary,
        error: null,
        affectedSymbols: v.verdict.affectedMethods.length,
        retried: v.retried,
        latencyMs: v.latencyMs,
        totalTokens: v.totalTokens,
        model: v.model,
      }
    : {
        breaking: null,
        confidence: null,
        summary: null,
        error: v.error,
        affectedSymbols: 0,
        retried: v.retried,
        latencyMs: v.latencyMs,
        totalTokens: v.totalTokens,
        model: v.model,
      };

  const scanSummary = result.scan
    ? {
        targetPath: result.scan.targetPath,
        backend: result.scan.backend,
        scanned: result.scan.scanned,
        symbolsWithHits: result.scan.usages.filter((u) => u.matchCount > 0).length,
        totalMatches: result.scan.usages.reduce((sum, u) => sum + u.matchCount, 0),
      }
    : null;

  const draftSummary = result.draft
    ? {
        symbolsWithMatches: result.draft.totals.symbolsWithMatches,
        suggestions: result.draft.totals.suggestions,
        highConfidence: result.draft.totals.highConfidence,
        mediumConfidence: result.draft.totals.mediumConfidence,
        lowConfidence: result.draft.totals.lowConfidence,
        manualReview: result.draft.totals.manualReview,
        errors: result.draft.totals.errors,
      }
    : null;

  const prSummary = result.pr
    ? {
        ok: result.pr.ok,
        branchCreated: result.pr.branchCreated,
        applied: result.pr.applied,
        skipped: result.pr.skipped,
        prUrl: result.pr.prUrl ?? null,
        prNumber: result.pr.prNumber ?? null,
        error: result.pr.error ?? null,
      }
    : null;

  return {
    runId: result.runId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    packageName: result.packageName,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    ok: result.ok,
    verdict: verdictSummary,
    scan: scanSummary,
    draft: draftSummary,
    reportPath: result.reportPath,
    pr: prSummary,
    error: result.error ?? null,
  };
}

/**
 * Append a single run record to the JSONL history file.
 * Creates `data/` and the file itself if they don't yet exist.
 */
export async function appendRun(result: RunFullCheckResult): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const entry = toRunHistoryEntry(result);
  await fs.promises.appendFile(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Read every history row, newest first. Returns [] when the file does
 * not exist (the common case before the first run).
 */
export async function listRuns(): Promise<RunHistoryEntry[]> {
  try {
    const raw = await fs.promises.readFile(HISTORY_FILE, 'utf8');
    const entries: RunHistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as RunHistoryEntry);
      } catch {
        // Skip a malformed line rather than lose the whole list. In practice
        // this should never happen — appendRun is the only writer.
      }
    }
    return entries.reverse();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Look up one run by id. Returns null when not found.
 */
export async function getRun(runId: string): Promise<RunHistoryEntry | null> {
  const runs = await listRuns();
  return runs.find((r) => r.runId === runId) ?? null;
}

/**
 * Aggregate metrics that the dashboard's metric cards read directly.
 * Computed from the full history, never hardcoded.
 */
export interface DashboardMetrics {
  /** Distinct packages that appear in the history (count, not list). */
  dependenciesTracked: number;
  /** Total number of runs ever recorded. */
  checksRun: number;
  /** Number of runs where the verdict said breaking === true. */
  breakingChangesFound: number;
  /** Number of runs that resulted in a PR opened (pr.ok === true). */
  prsOpened: number;
}

export function computeMetrics(runs: RunHistoryEntry[]): DashboardMetrics {
  const packages = new Set<string>();
  let breaking = 0;
  let prsOpened = 0;

  for (const r of runs) {
    packages.add(r.packageName);
    if (r.verdict.breaking === true) breaking += 1;
    if (r.pr?.ok) prsOpened += 1;
  }

  return {
    dependenciesTracked: packages.size,
    checksRun: runs.length,
    breakingChangesFound: breaking,
    prsOpened,
  };
}