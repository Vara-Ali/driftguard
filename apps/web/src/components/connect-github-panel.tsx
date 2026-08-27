'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { GitBranch, Plus } from 'lucide-react';
import type { Installation } from '@/lib/api';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';

/**
 * Phase 2 — the "Connect GitHub" button + installed-repos list.
 *
 * Plain client component: the install flow is a server-side redirect
 * to GitHub, the button just navigates. No state to manage beyond
 * opening the link. The list renders what `/api/installations` returned
 * (server-side); this component only owns the button.
 *
 * Phase 2's install flow lives server-side in apps/api/src/server.ts
 * (the GET /api/github/install + /api/github/callback routes). The
 * dashboard only owns the entry point.
 */
export function ConnectGitHubPanel({ installations }: { installations: Installation[] }) {
  function startInstall() {
    window.location.href = `${API_BASE}/api/github/install`;
  }

  if (installations.length === 0) {
    return (
      <Card className="border-zinc-800 bg-zinc-900/40 p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
            <GitBranch className="size-5 text-zinc-300" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Connect GitHub</h2>
            <p className="mt-1 max-w-md text-xs text-zinc-400">
              DriftGuard opens draft PRs via a GitHub App, not your personal access token.
              Authorize the App on the repos you want it to watch.
            </p>
          </div>
          <Button onClick={startInstall} className="mt-2">
            <GitBranch className="size-4" />
            Connect GitHub
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {installations.map((installation) => (
        <Card key={installation.githubInstallationId} className="border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">
                {installation.ownerKind === 'organization' ? '@' : ''}
                {installation.ownerGithubLogin}
              </h3>
              <p className="text-xs text-zinc-500">
                Installation #{installation.githubInstallationId} ·{' '}
                {installation.repos.length} repo
                {installation.repos.length === 1 ? '' : 's'}
              </p>
            </div>
            <Button onClick={startInstall} variant="outline" size="sm">
              <Plus className="size-3.5" />
              Add more repos
            </Button>
          </div>
          <ul className="mt-4 divide-y divide-zinc-800">
            {installation.repos.map((repo) => (
              <li key={repo.repoId} className="flex items-center justify-between py-2">
                <span className="font-mono text-sm text-zinc-200">{repo.repoFullName}</span>
                <span className="text-xs text-zinc-500">default branch: {repo.defaultBranch}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}