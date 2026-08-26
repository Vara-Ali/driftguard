// The `resolution-mode` attribute is required to pull a type out of an
// ESM-only package from a CommonJS file. Type-only, erased at runtime.
import type { Octokit as OctokitType } from '@octokit/rest' with { 'resolution-mode': 'import' };

/**
 * Shared Octokit instance.
 *
 * @octokit/rest v22 is ESM-only while this project is CommonJS (so that plain
 * `ts-node` works), so it has to come in through a dynamic `import()`. That is
 * a runtime cost worth paying once rather than per call site — hence the
 * cached promise here instead of each module importing it for itself.
 */

let clientPromise: Promise<OctokitType> | null = null;

/** Raised when GitHub work is attempted without a usable token. */
export class MissingTokenError extends Error {
  constructor() {
    super('GITHUB_TOKEN is not set — cannot call the GitHub API.');
    this.name = 'MissingTokenError';
  }
}

/** True when a usable-looking token is configured. */
export function hasGitHubToken(): boolean {
  const token = process.env.GITHUB_TOKEN?.trim();
  return Boolean(token) && token !== 'ghp_your_token_here';
}

/**
 * Get the shared authenticated Octokit client.
 *
 * Throws MissingTokenError when no token is configured — callers that can
 * degrade gracefully should check `hasGitHubToken()` first.
 */
export function getOctokit(): Promise<OctokitType> {
  if (!hasGitHubToken()) {
    return Promise.reject(new MissingTokenError());
  }

  if (!clientPromise) {
    clientPromise = import('@octokit/rest').then(
      ({ Octokit }) => new Octokit({ auth: process.env.GITHUB_TOKEN?.trim() }),
    );
  }

  return clientPromise;
}
