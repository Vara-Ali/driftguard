import 'dotenv/config';
import { config as loadRootEnv } from 'dotenv';
import * as path from 'path';

// DriftGuard reads MINIMAX_API_KEY and GITHUB_TOKEN from process.env. The
// user's real `.env` lives at the repo root. Load it explicitly here so
// the API server works no matter which directory it's started from.
loadRootEnv({ path: path.resolve(__dirname, '../../../.env') });

import express, { type Request, type Response } from 'express';
import cors from 'cors';

import { runFullCheck, type RunFullCheckArgs, type RunFullCheckPrOptions } from 'src/run-full-check';
import { appendRun, listRuns, getRun, computeMetrics, type RunHistoryEntry } from 'src/run-history';
import { setInstallationOctokitFactory } from 'src/octokit-client';
import { getInstallationOctokit } from './github-app';
import { registerShutdownHandlers } from './db';
import githubRouter from './routes/github';
import testInstallationRouter from './routes/test-installation';

/**
 * DriftGuard internal HTTP API.
 *
 * Phase 1 endpoints:
 *   GET  /api/health         → { ok: true }
 *   GET  /api/runs           → RunHistoryEntry[] (newest first)
 *   GET  /api/runs/:id       → RunHistoryEntry | 404
 *   GET  /api/metrics        → DashboardMetrics
 *   POST /api/checks         → RunFullCheckResult (and appends to history)
 *
 * Phase 2 endpoints:
 *   GET  /api/github/install                       → 302 to GitHub
 *   GET  /api/github/callback                      → 302 to /repositories
 *   GET  /api/installations                        → Installation[]
 *   GET  /api/github/test-installation/:id         → token-minter smoke test
 *
 * The server is intentionally synchronous per request — long-running LLM
 * fix-draft stages can take minutes, and Express's default request timeout
 * is several minutes. Fine for a single-user MVP.
 */

const PORT = Number(process.env.PORT ?? 4000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: WEB_ORIGIN,
    credentials: false,
  }),
);

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/api/runs', async (_req: Request, res: Response) => {
  try {
    const runs: RunHistoryEntry[] = await listRuns();
    res.json(runs);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/runs/:id', async (req: Request, res: Response) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: `No run with id ${req.params.id}` });
      return;
    }
    res.json(run);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/metrics', async (_req: Request, res: Response) => {
  try {
    const runs = await listRuns();
    res.json(computeMetrics(runs));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

interface CheckRequestBody {
  packageName?: unknown;
  fromVersion?: unknown;
  toVersion?: unknown;
  targetRepoPath?: unknown;
  prOptions?: unknown;
  installationId?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function parsePrOptions(raw: unknown): RunFullCheckPrOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!isString(r.owner) || !isString(r.repo) || !isString(r.baseBranch)) {
    return undefined;
  }
  return { owner: r.owner, repo: r.repo, baseBranch: r.baseBranch };
}

function parseInstallationId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

app.post('/api/checks', async (req: Request, res: Response) => {
  const body = req.body as CheckRequestBody;

  if (!isString(body.packageName)) {
    res.status(400).json({ error: 'packageName is required and must be a non-empty string.' });
    return;
  }
  if (!isString(body.fromVersion)) {
    res.status(400).json({ error: 'fromVersion is required and must be a non-empty string.' });
    return;
  }
  if (!isString(body.toVersion)) {
    res.status(400).json({ error: 'toVersion is required and must be a non-empty string.' });
    return;
  }
  if (!isString(body.targetRepoPath)) {
    res.status(400).json({ error: 'targetRepoPath is required and must be a non-empty string.' });
    return;
  }

  const installationId = parseInstallationId(body.installationId);
  const args: RunFullCheckArgs = {
    packageName: body.packageName,
    fromVersion: body.fromVersion,
    toVersion: body.toVersion,
    targetRepoPath: body.targetRepoPath,
    prOptions: parsePrOptions(body.prOptions),
    ...(installationId !== undefined ? { installationId } : {}),
  };

  try {
    const result = await runFullCheck(args);
    try {
      await appendRun(result);
    } catch (e) {
      // History-write failure shouldn't lose the run result.
      console.error(`Could not append to run history: ${(e as Error).message}`);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Phase 2 — GitHub App install flow + dashboard data endpoints.
app.use(githubRouter);
app.use(testInstallationRouter);

// Phase 2 — wire the installation-Octokit factory so the engine can mint
// short-lived installation tokens instead of falling back to GITHUB_TOKEN.
setInstallationOctokitFactory(async (installationId: number) => {
  return getInstallationOctokit(installationId);
});

registerShutdownHandlers();

app.listen(PORT, () => {
  console.log(`driftguard-api listening on http://localhost:${PORT}`);
  console.log(`CORS origin: ${WEB_ORIGIN}`);
  if (!process.env.SUPABASE_DB_URL) {
    console.warn(`SUPABASE_DB_URL is not set — /api/installations will 500.`);
  }
  if (!process.env.GITHUB_APP_ID) {
    console.warn(`GITHUB_APP_ID is not set — /api/github/install will 500.`);
  }
});