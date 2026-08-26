import 'dotenv/config';

/**
 * Day 1 smoke test for GitHub auth.
 *
 * The only goal is to prove GITHUB_TOKEN is wired correctly before any real
 * GitHub work starts on Day 2. It makes one read-only call (`GET /user`) and
 * reports back. No repository data is written, and nothing here is on the
 * critical path of the version check.
 *
 * Implementation note: @octokit/rest v22 is ESM-only, and this project is
 * CommonJS so that plain `ts-node` works. Node can `import()` an ESM module
 * from CJS at runtime, and tsconfig `module: node16` tells TypeScript to leave
 * the dynamic import alone instead of rewriting it to `require`.
 */

export interface GitHubAuthResult {
  ok: boolean;
  /** Authenticated account login, when the call succeeded. */
  login?: string;
  /** Token scopes as reported by the `x-oauth-scopes` response header. */
  scopes?: string;
  /** Rate limit remaining, a cheap sanity signal that we are authenticated. */
  rateLimitRemaining?: string;
  /** Human-readable reason the check failed. */
  error?: string;
}

/**
 * Make one authenticated read-only call to confirm the token works.
 *
 * Never throws — a broken token should not take down the version check, so
 * failures come back as `{ ok: false, error }` for the caller to report.
 */
export async function checkGitHubAuth(): Promise<GitHubAuthResult> {
  const token = process.env.GITHUB_TOKEN?.trim();

  if (!token) {
    return {
      ok: false,
      error: 'GITHUB_TOKEN is not set. Copy .env.example to .env and add a token.',
    };
  }

  if (token === 'ghp_your_token_here') {
    return {
      ok: false,
      error: 'GITHUB_TOKEN is still the placeholder value from .env.example.',
    };
  }

  try {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: token });

    const response = await octokit.rest.users.getAuthenticated();

    return {
      ok: true,
      login: response.data.login,
      // Fine-grained tokens report an empty scopes header; that is expected.
      scopes: (response.headers['x-oauth-scopes'] as string | undefined) || '(none reported)',
      rateLimitRemaining: response.headers['x-ratelimit-remaining'] as string | undefined,
    };
  } catch (error) {
    const status = (error as { status?: number }).status;

    if (status === 401) {
      return { ok: false, error: 'GitHub rejected the token (401). It may be expired or revoked.' };
    }
    if (status === 403) {
      return { ok: false, error: 'GitHub returned 403 — token lacks permission, or rate limited.' };
    }

    return { ok: false, error: `GitHub auth check failed: ${(error as Error).message}` };
  }
}

/** Print the result of the auth check in the same style as the rest of the CLI. */
export function reportGitHubAuth(result: GitHubAuthResult): void {
  if (result.ok) {
    console.log(`GitHub auth: OK as ${result.login} (scopes: ${result.scopes})`);
    if (result.rateLimitRemaining) {
      console.log(`             ${result.rateLimitRemaining} API requests remaining this hour`);
    }
  } else {
    console.log(`GitHub auth: NOT CONFIGURED — ${result.error}`);
  }
}

// Allow running this file directly as a standalone smoke test:
//   npm run check:github
if (require.main === module) {
  checkGitHubAuth()
    .then((result) => {
      reportGitHubAuth(result);
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unexpected failure in GitHub auth check:', error);
      process.exit(1);
    });
}
