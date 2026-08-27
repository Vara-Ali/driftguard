import { Card } from '@/components/ui/card';
import { CheckCircle2, FolderGit2 } from 'lucide-react';
import { fetchInstallations } from '@/lib/api';
import { ConnectGitHubPanel } from '@/components/connect-github-panel';

/**
 * Repositories — server component.
 *
 * Server-side render of the dashboard's Repositories page. Reads
 * `/api/installations` from the API server and hands the list to the
 * client component for the Connect-GitHub button. Recognizes a `?installed=1`
 * query param (set by an explicit navigation, but mainly a placeholder for
 * a future flow) and shows a success banner.
 */
export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams?: Promise<{ installed?: string; installation_id?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const justInstalled = params.installed === '1';

  let installations: Awaited<ReturnType<typeof fetchInstallations>> = [];
  let fetchError: string | null = null;
  try {
    installations = await fetchInstallations();
  } catch (e) {
    fetchError = (e as Error).message;
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Repositories</h1>
        <p className="text-sm text-zinc-400">
          GitHub installations connected to DriftGuard, and the repos each one can write PRs to.
        </p>
      </header>

      {justInstalled && installations.length > 0 ? (
        <Card className="border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-4 text-emerald-400" />
            <div>
              <p className="text-sm text-emerald-300">
                Connected — {installations[0].ownerGithubLogin} now authorizes DriftGuard on{' '}
                {installations[0].repos.length} repo
                {installations[0].repos.length === 1 ? '' : 's'}.
              </p>
              {params.installation_id ? (
                <p className="mt-1 font-mono text-xs text-zinc-500">
                  installation_id = {params.installation_id}
                </p>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {fetchError ? (
        <Card className="border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-sm text-amber-300">
            Could not load installations: {fetchError}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Check that <code className="font-mono">apps/api</code> is running and that
            <code className="font-mono"> SUPABASE_DB_URL</code> is set in <code className="font-mono">.env</code>.
          </p>
        </Card>
      ) : (
        <ConnectGitHubPanel installations={installations} />
      )}

      {installations.length === 0 && !fetchError ? (
        <Card className="border-zinc-800 bg-zinc-900/40 p-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <FolderGit2 className="size-8 text-zinc-600" />
            <p className="text-sm text-zinc-400">
              No repositories connected yet.
            </p>
            <p className="max-w-sm text-xs text-zinc-500">
              Click <span className="font-medium text-zinc-300">Connect GitHub</span> above to
              authorize the DriftGuard GitHub App on the repos you want it to watch.
            </p>
          </div>
        </Card>
      ) : null}
    </div>
  );
}