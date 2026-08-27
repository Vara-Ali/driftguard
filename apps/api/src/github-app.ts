// The `resolution-mode` attribute is required to pull a type out of an
// ESM-only package from a CommonJS file. Type-only, erased at runtime.
import type { StrategyOptions } from '@octokit/auth-app' with { 'resolution-mode': 'import' };
import type { Octokit as OctokitType } from '@octokit/rest' with { 'resolution-mode': 'import' };

/**
 * Phase 2 — GitHub App authentication.
 *
 * Two distinct operations live here:
 *
 *   1. `getInstallationToken(installationId)` — mint a short-lived
 *      installation access token using the App's private key. This is what
 *      `runOpenPr` should use for any automated repo write, replacing the
 *      personal-access-token path from Days 1-6.
 *
 *   2. `listInstallationRepos(installationId)` — used by the install
 *      callback to write one `connected_repos` row per repo the user
 *      authorized.
 *
 * The `App` instance is constructed lazily from env vars (GITHUB_APP_ID,
 * GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY,
 * GITHUB_APP_WEBHOOK_SECRET). Any missing var raises `MissingAppConfigError`
 * so the caller can return a clean 500 instead of a stack trace.
 *
 * Both @octokit/auth-app and @octokit/rest are ESM-only. We mirror the pattern
 * already used in src/octokit-client.ts: dynamic import() inside a cached
 * promise so the cost is paid once.
 *
 * Note: @octokit/auth-app v7 exports `createAppAuth(options)` (a strategy
 * factory) instead of an `App` class. We use that factory to get an
 * `AuthInterface` and then call `getInstallationAccessToken` /
 * `getInstallation` on it.
 */

export class MissingAppConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `GitHub App not configured — missing env vars: ${missing.join(', ')}. ` +
        `See docs/github-app-setup.md.`,
    );
    this.name = 'MissingAppConfigError';
    this.missing = missing;
  }
}

interface AppConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret?: string;
}

function readConfig(): AppConfig {
  const missing: string[] = [];
  const appId = process.env.GITHUB_APP_ID?.trim();
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
  // Private key is multi-line PEM. We accept either raw or escaped-newline
  // form (the .env.example uses the escaped form because dotenv doesn't
  // support real multi-line values).
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET?.trim();

  if (!appId) missing.push('GITHUB_APP_ID');
  if (!clientId) missing.push('GITHUB_APP_CLIENT_ID');
  if (!clientSecret) missing.push('GITHUB_APP_CLIENT_SECRET');
  if (!privateKey || !privateKey.includes('BEGIN RSA PRIVATE KEY')) {
    missing.push('GITHUB_APP_PRIVATE_KEY');
  }

  if (missing.length > 0) {
    throw new MissingAppConfigError(missing);
  }

  return {
    appId: appId!,
    clientId: clientId!,
    clientSecret: clientSecret!,
    privateKey: privateKey!,
    webhookSecret,
  };
}

let authPromise: Promise<unknown> | null = null;

type AppAuth = (
  options:
    | { type: 'app' }
    | { type: 'installation'; installationId: number | string },
) => Promise<{
  token: string;
  expiresAt?: string;
  permissions?: Record<string, string>;
  repositorySelection?: 'all' | 'selected' | null;
}>;

async function getAppAuth(): Promise<AppAuth> {
  if (!authPromise) {
    const cfg = readConfig();
    const options: StrategyOptions = {
      appId: cfg.appId,
      privateKey: cfg.privateKey,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      ...(cfg.webhookSecret ? { webhookSecret: cfg.webhookSecret } : {}),
    };
    authPromise = import('@octokit/auth-app').then(({ createAppAuth }) =>
      createAppAuth(options),
    );
  }
  return authPromise as Promise<AppAuth>;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
  repositorySelection: 'all' | 'selected' | null;
}

/**
 * Mint a short-lived installation access token.
 *
 * @octokit/auth-app v7 returns a callable strategy. Calling
 * `appAuth({ type: 'installation', installationId })` POSTs to
 * /app/installations/:id/access_tokens with a JWT signed by the App's private
 * key. GitHub returns a token that lives for one hour and is scoped to the
 * repos the user authorized at install time.
 */
export async function getInstallationToken(installationId: number): Promise<InstallationToken> {
  const appAuth = await getAppAuth();
  const result = await appAuth({ type: 'installation', installationId });
  return {
    token: result.token,
    expiresAt: result.expiresAt ?? '',
    permissions: result.permissions ?? {},
    repositorySelection: (result.repositorySelection as 'all' | 'selected' | null) ?? null,
  };
}

let installationOctokitPromiseCache: Map<number, Promise<OctokitType>> = new Map();

/**
 * Return an Octokit instance authenticated as the installation. Used by any
 * operation that should run as the App on behalf of a connected user or org.
 *
 * Each installation gets its own cached Octokit; tokens are short-lived so
 * the cache window is intentionally tight (one Octokit per installation per
 * process). Callers that need a fresh token (e.g. after a 401) should call
 * `getInstallationToken` directly and construct a fresh Octokit.
 */
export async function getInstallationOctokit(installationId: number): Promise<OctokitType> {
  const cached = installationOctokitPromiseCache.get(installationId);
  if (cached) return cached;

  const promise = (async (): Promise<OctokitType> => {
    const { Octokit } = await import('@octokit/rest');
    const installationToken = await getInstallationToken(installationId);
    return new Octokit({ auth: installationToken.token });
  })();

  installationOctokitPromiseCache.set(installationId, promise);
  return promise;
}

/**
 * Reset the per-installation Octokit cache. Call this when a token has
 * expired or a request returned 401 — the next `getInstallationOctokit` call
 * will mint a fresh token.
 */
export function clearInstallationOctokitCache(installationId?: number): void {
  if (installationId === undefined) {
    installationOctokitPromiseCache = new Map();
    return;
  }
  installationOctokitPromiseCache.delete(installationId);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Install-flow helpers (used by the /api/github/install + callback routes)
 * ──────────────────────────────────────────────────────────────────────── */

export interface InstallationRepoSummary {
  repoId: number;
  repoFullName: string;
  defaultBranch: string;
}

export async function listInstallationRepos(
  installationId: number,
): Promise<InstallationRepoSummary[]> {
  const octokit = await getInstallationOctokit(installationId);

  // The installation Octokit scopes requests to the repos the user
  // authorized at install time, so /installation/repositories returns
  // exactly that list — no extra filtering needed.
  const response = await octokit.request('GET /installation/repositories');
  type RepoNode = {
    id: number;
    full_name: string;
    default_branch: string;
  };
  const repos = (response.data as { repositories?: RepoNode[] }).repositories ?? [];
  return repos.map((r) => ({
    repoId: r.id,
    repoFullName: r.full_name,
    defaultBranch: r.default_branch,
  }));
}

export async function getInstallationAccount(installationId: number): Promise<{
  accountLogin: string;
  accountKind: 'user' | 'organization';
}> {
  // @octokit/auth-app v7's strategy is a callable. To read the account
  // metadata attached to an installation we have to mint an App-level
  // JWT (`{ type: 'app' }`) and call /app/installations/:id as the App
  // itself.
  const appAuth = await getAppAuth();
  const { token } = await appAuth({ type: 'app' });
  const { Octokit } = await import('@octokit/rest');
  const appOctokit = new Octokit({ auth: token });
  const { data } = await appOctokit.request('GET /app/installations/{installation_id}', {
    installation_id: installationId,
  });
  const account = data.account as
    | ({ login: string; type?: string } & Record<string, unknown>)
    | null
    | undefined;
  if (!account) {
    throw new Error(`Installation ${installationId} has no account attached.`);
  }
  // GitHub types the account as User | Enterprise | Organization; for Phase 2
  // we only care about user vs organization (personal-account installs vs
  // org installs).
  const kind = account.type === 'Organization' ? 'organization' : 'user';
  return {
    accountLogin: account.login,
    accountKind: kind,
  };
}
