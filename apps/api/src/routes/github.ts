import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'crypto';

import { query, queryOne } from '../db';
import {
  getInstallationAccount,
  listInstallationRepos,
  MissingAppConfigError,
} from '../github-app';

const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Phase 2 — GitHub App install flow.
 *
 * Endpoints:
 *
 *   GET /api/github/install
 *     Generates a CSRF state nonce, stores it in install_states (10-minute
 *     TTL), and 302-redirects the browser to GitHub's
 *     https://github.com/apps/<slug>/installations/new?state=<nonce> URL.
 *     When the user finishes authorizing on GitHub, GitHub redirects them
 *     back to the callback URL below with the same state.
 *
 *   GET /api/github/callback?installation_id=<id>&state=<nonce>
 *     Verifies the state nonce matches a row we issued, then:
 *       1. fetches the installation's repos via the installation Octokit,
 *       2. upserts the installations row (one per github_installation_id),
 *       3. upserts one connected_repos row per authorized repo,
 *       4. 302-redirects back to the dashboard's /repositories page.
 *
 *   GET /api/installations
 *     Returns the installations + connected repos for the current dev user.
 *     The shape mirrors what apps/web/src/lib/api.ts declares.
 */

const router = Router();

function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
}

function appSlug(): string {
  const raw = process.env.GITHUB_APP_SLUG?.trim();
  if (!raw) {
    throw new MissingAppConfigError(['GITHUB_APP_SLUG']);
  }
  // Strip the public-link prefix if the user pasted the full URL instead of
  // just the slug. `https://github.com/apps/driftguard-dev` → `driftguard-dev`.
  // Trailing slashes and whitespace are tolerated.
  const slug = raw.replace(/^https?:\/\/github\.com\/apps\//i, '').replace(/\/+$/, '').trim();
  if (!slug) {
    throw new MissingAppConfigError(['GITHUB_APP_SLUG']);
  }
  return slug;
}

function dashboardReturnUrl(): string {
  return `${webOrigin()}/repositories`;
}

interface InstallStateRow {
  state: string;
}

interface InstallationRow {
  id: string;
  github_installation_id: string;
  owner_kind: 'user' | 'organization';
  owner_github_login: string;
  installed_by_user_id: string;
  installed_at: Date;
}

interface ConnectedRepoRow {
  id: string;
  installation_id: string;
  repo_full_name: string;
  repo_id: string;
  default_branch: string;
  added_at: Date;
}

/* ──────────────────────────────────────────────────────────────────────────
 * GET /api/github/install
 * ──────────────────────────────────────────────────────────────────────── */

router.get('/api/github/install', async (_req: Request, res: Response) => {
  try {
    const slug = appSlug();
    const state = randomBytes(24).toString('hex');

    await query(
      `insert into install_states (state) values ($1)`,
      [state],
    );

    const target = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
    res.redirect(302, target);
  } catch (e) {
    if (e instanceof MissingAppConfigError) {
      res.status(500).json({ error: e.message, missing: e.missing });
      return;
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * GET /api/github/callback
 * ──────────────────────────────────────────────────────────────────────── */

router.get('/api/github/callback', async (req: Request, res: Response) => {
  const installationIdRaw = req.query.installation_id;
  const stateRaw = req.query.state;

  if (typeof installationIdRaw !== 'string' || installationIdRaw.length === 0) {
    res.status(400).json({ error: 'installation_id query param is required.' });
    return;
  }
  if (typeof stateRaw !== 'string' || stateRaw.length === 0) {
    res.status(400).json({ error: 'state query param is required.' });
    return;
  }

  const installationId = Number(installationIdRaw);
  if (!Number.isFinite(installationId) || installationId <= 0) {
    res.status(400).json({ error: `installation_id is not a positive integer: ${installationIdRaw}` });
    return;
  }

  // 1. Verify the state nonce. We delete the row on read so it cannot be
  //    replayed, and we filter on expires_at so stale nonces are rejected.
  const state = await queryOne<InstallStateRow>(
    `delete from install_states
       where state = $1
         and expires_at > now()
     returning state`,
    [stateRaw],
  );
  if (!state) {
    res.status(400).json({ error: 'Invalid or expired state. Restart the install flow from the dashboard.' });
    return;
  }

  try {
    // 2. Look up the install's account metadata via the App Octokit.
    const account = await getInstallationAccount(installationId);

    // 3. List the repos the user authorized. The installation Octokit
    //    scopes this call to exactly those repos.
    const repos = await listInstallationRepos(installationId);

    // 4. Upsert the installation row. On conflict (re-install or re-auth),
    //    refresh the owner metadata and installed_at timestamp.
    const installation = await queryOne<InstallationRow>(
      `insert into installations (github_installation_id, owner_kind, owner_github_login, installed_by_user_id, installed_at)
       values ($1, $2, $3, $4, now())
       on conflict (github_installation_id) do update
         set owner_kind = excluded.owner_kind,
             owner_github_login = excluded.owner_github_login,
             installed_by_user_id = excluded.installed_by_user_id,
             installed_at = now()
       returning id, github_installation_id, owner_kind, owner_github_login, installed_by_user_id, installed_at`,
      [
        installationId.toString(),
        account.accountKind,
        account.accountLogin,
        DEV_USER_ID,
      ],
    );
    if (!installation) {
      throw new Error('Insert returned no row — Postgres upsert failed silently.');
    }

    // 5. Upsert each connected repo. Use repo_id as the conflict target —
    //    if a repo moves between installations, the unique constraint on
    //    (installation_id, repo_full_name) plus the row id keeps things sane.
    for (const repo of repos) {
      await query(
        `insert into connected_repos (installation_id, repo_full_name, repo_id, default_branch)
         values ($1, $2, $3, $4)
         on conflict (installation_id, repo_full_name) do update
           set repo_id = excluded.repo_id,
               default_branch = excluded.default_branch`,
        [installation.id, repo.repoFullName, repo.repoId.toString(), repo.defaultBranch],
      );
    }

    // 6. Land the user back on the dashboard's Repositories page.
    res.redirect(302, dashboardReturnUrl());
  } catch (e) {
    if (e instanceof MissingAppConfigError) {
      res.status(500).json({ error: e.message, missing: e.missing });
      return;
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * GET /api/installations
 * ──────────────────────────────────────────────────────────────────────── */

router.get('/api/installations', async (_req: Request, res: Response) => {
  try {
    const installations = await query<InstallationRow>(
      `select id, github_installation_id, owner_kind, owner_github_login, installed_by_user_id, installed_at
         from installations
         where installed_by_user_id = $1
         order by installed_at desc`,
      [DEV_USER_ID],
    );

    if (installations.length === 0) {
      res.json([]);
      return;
    }

    const ids = installations.map((i) => i.id);
    const repos = await query<ConnectedRepoRow>(
      `select id, installation_id, repo_full_name, repo_id, default_branch, added_at
         from connected_repos
         where installation_id = any($1::uuid[])
         order by added_at asc`,
      [ids],
    );

    const reposByInstallation = new Map<string, ConnectedRepoRow[]>();
    for (const r of repos) {
      const list = reposByInstallation.get(r.installation_id);
      if (list) list.push(r);
      else reposByInstallation.set(r.installation_id, [r]);
    }

    res.json(
      installations.map((i) => ({
        githubInstallationId: Number(i.github_installation_id),
        ownerKind: i.owner_kind,
        ownerGithubLogin: i.owner_github_login,
        installedAt: i.installed_at.toISOString(),
        repos: (reposByInstallation.get(i.id) ?? []).map((r) => ({
          repoFullName: r.repo_full_name,
          repoId: Number(r.repo_id),
          defaultBranch: r.default_branch,
          addedAt: r.added_at.toISOString(),
        })),
      })),
    );
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
