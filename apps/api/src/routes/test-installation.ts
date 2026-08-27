import { Router, type Request, type Response } from 'express';

import { queryOne } from '../db';
import {
  getInstallationToken,
  getInstallationOctokit,
  MissingAppConfigError,
} from '../github-app';

/**
 * Phase 2 — token-minter smoke test.
 *
 *   GET /api/github/test-installation/:installationId
 *
 *   1. Mints a fresh installation access token (proves private-key auth works).
 *   2. Reads the first connected repo for that installation from Postgres.
 *   3. Calls GET /repos/:owner/:repo with the installation Octokit and
 *      returns the default branch name.
 *
 * If `defaultBranch` is non-null in the response, the full chain works:
 *   - App-level JWT signed by the private key
 *   - installation access token POST
 *   - installation-scoped Octokit
 *   - real GitHub API call
 *
 * This is the Phase 2 equivalent of src/write-scope-test.ts from Day 6.
 */

interface ConnectedRepoRow {
  repo_full_name: string;
  default_branch: string;
}

const router = Router();

router.get('/api/github/test-installation/:installationId', async (req: Request, res: Response) => {
  const id = Number(req.params.installationId);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: `installationId is not a positive integer: ${req.params.installationId}` });
    return;
  }

  try {
    const installationToken = await getInstallationToken(id);

    // Look up the first connected repo. The schema uses the surrogate uuid
    // as the join key from connected_repos → installations.
    const repo = await queryOne<ConnectedRepoRow>(
      `select cr.repo_full_name, cr.default_branch
         from connected_repos cr
         join installations i on i.id = cr.installation_id
        where i.github_installation_id = $1
        order by cr.added_at asc
        limit 1`,
      [id.toString()],
    );

    if (!repo) {
      res.status(404).json({
        ok: false,
        error: `No connected repos for installation ${id}. Run the install flow first.`,
        tokenExpiresAt: installationToken.expiresAt,
      });
      return;
    }

    const [owner, name] = repo.repo_full_name.split('/');
    if (!owner || !name) {
      res.status(500).json({ error: `repo_full_name is malformed: ${repo.repo_full_name}` });
      return;
    }

    const octokit = await getInstallationOctokit(id);
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', {
      owner,
      repo: name,
    });

    res.json({
      ok: true,
      repo: repo.repo_full_name,
      // Prefer the live API's default_branch over the cached value — proves
      // the token authenticated a real request.
      defaultBranch: data.default_branch,
      cachedDefaultBranch: repo.default_branch,
      tokenExpiresAt: installationToken.expiresAt,
      permissions: installationToken.permissions,
      repositorySelection: installationToken.repositorySelection,
    });
  } catch (e) {
    if (e instanceof MissingAppConfigError) {
      res.status(500).json({ error: e.message, missing: e.missing });
      return;
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
