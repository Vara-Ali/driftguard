/**
 * Dashboard data layer.
 *
 * Pure functions that fetch from the DriftGuard API server running on
 * :4000. Server components in app/page.tsx and app/(dashboard)/repositories/page.tsx
 * call these directly; client components trigger checks via the form below.
 *
 * All requests run server-side from the dashboard's Node process, so
 * `API_BASE` is read from the server environment at runtime. Set
 * `API_BASE=http://localhost:4000` in apps/web/.env.local for dev.
 */

const API_BASE = process.env.API_BASE ?? 'http://localhost:4000';

/* ──────────────────────────────────────────────────────────────────────────
 * Types — mirror the shapes the API server returns. Kept inline (not
 * imported from src/run-history) because the dashboard is a separate
 * TypeScript project and a cross-project import would require path
 * mapping that Next's bundler doesn't honor. The mirror is cheap; the
 * API contract is locked.
 * ──────────────────────────────────────────────────────────────────────── */

export interface DashboardMetrics {
  dependenciesTracked: number;
  checksRun: number;
  breakingChangesFound: number;
  prsOpened: number;
}

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

export interface CheckRequest {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  targetRepoPath: string;
  prOptions?: { owner: string; repo: string; baseBranch: string };
  installationId?: number;
}

export interface RunFullCheckResult {
  ok: boolean;
  runId: string;
  startedAt: string;
  finishedAt: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  verdict: unknown;
  scan: unknown;
  draft: unknown;
  reportPath: string | null;
  pr: {
    ok: boolean;
    branchCreated: boolean;
    applied: number;
    skipped: number;
    prUrl?: string;
    prNumber?: number;
    error?: string;
  } | null;
  error?: string;
}

export interface Installation {
  githubInstallationId: number;
  ownerKind: 'user' | 'organization';
  ownerGithubLogin: string;
  installedAt: string;
  repos: ConnectedRepo[];
}

export interface ConnectedRepo {
  repoFullName: string;
  repoId: number;
  defaultBranch: string;
  addedAt: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Read endpoints
 * ──────────────────────────────────────────────────────────────────────── */

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${path} → HTTP ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchMetrics(): Promise<DashboardMetrics> {
  return getJson<DashboardMetrics>('/api/metrics');
}

export async function fetchRuns(): Promise<RunHistoryEntry[]> {
  return getJson<RunHistoryEntry[]>('/api/runs');
}

export async function fetchRun(id: string): Promise<RunHistoryEntry | null> {
  try {
    return await getJson<RunHistoryEntry>(`/api/runs/${encodeURIComponent(id)}`);
  } catch (e) {
    if ((e as Error).message.includes('HTTP 404')) return null;
    throw e;
  }
}

export async function fetchInstallations(): Promise<Installation[]> {
  return getJson<Installation[]>('/api/installations');
}

/* ──────────────────────────────────────────────────────────────────────────
 * Write endpoint
 * ──────────────────────────────────────────────────────────────────────── */

export async function triggerCheck(body: CheckRequest): Promise<RunFullCheckResult> {
  const res = await fetch(`${API_BASE}/api/checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/api/checks → HTTP ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as RunFullCheckResult;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Display helpers
 * ──────────────────────────────────────────────────────────────────────── */

export function verdictLabel(run: RunHistoryEntry): { label: string; tone: 'breaking' | 'safe' | 'neutral' } {
  if (run.verdict.error) return { label: 'error', tone: 'neutral' };
  if (run.verdict.breaking === true) return { label: 'breaking', tone: 'breaking' };
  if (run.verdict.breaking === false) return { label: 'safe', tone: 'safe' };
  return { label: 'unknown', tone: 'neutral' };
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  if (Number.isNaN(then)) return iso;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}