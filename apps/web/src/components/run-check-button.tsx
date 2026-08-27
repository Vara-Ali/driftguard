'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { triggerCheck, fetchInstallations, type CheckRequest, type Installation } from '@/lib/api';

/**
 * Run a check. Client component because it manages local form state.
 *
 * On success calls `router.refresh()` so the dashboard's server component
 * re-fetches metrics + runs without a manual page reload. The button
 * disables itself while in flight; the actual check takes minutes because
 * the LLM fix-draft stage is sequential and one LLM call per match.
 *
 * Defaults are pre-filled to the demo case from Days 6–7 so a single
 * click re-creates the validation PR against the disposable
 * driftguard-e2e-target repo. Edit the fields for a different check.
 *
 * Phase 2: when installations are connected, the form exposes an
 * "Installation" dropdown. Picking one threads `installationId` through
 * `POST /api/checks`, so the API uses the GitHub App token instead of the
 * PAT to push the branch + open the PR.
 */
export function RunCheckButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [installations, setInstallations] = React.useState<Installation[]>([]);

  const [packageName, setPackageName] = React.useState('whatsapp-web.js');
  const [fromVersion, setFromVersion] = React.useState('1.34.6');
  const [toVersion, setToVersion] = React.useState('1.34.7');
  const [targetRepoPath, setTargetRepoPath] = React.useState(
    '/mnt/c/Users/Vara/projects/driftguard-e2e',
  );
  const [prOwner, setPrOwner] = React.useState('Vara-Ali');
  const [prRepo, setPrRepo] = React.useState('driftguard-e2e-target');
  const [prBaseBranch, setPrBaseBranch] = React.useState('main');
  const [openPr, setOpenPr] = React.useState(true);
  const [installationId, setInstallationId] = React.useState<string>('');

  // Fetch installations lazily — only when the dialog opens, so opening
  // it on a fresh page doesn't add an extra round-trip on first paint.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchInstallations()
      .then((list) => {
        if (cancelled) return;
        setInstallations(list);
        // Pre-select the first installation if the user hasn't picked yet.
        if (list.length > 0 && installationId === '') {
          setInstallationId(String(list[0].githubInstallationId));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`Could not load installations: ${(e as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
    // We intentionally exclude `installationId` from deps so this only
    // runs when `open` flips. Auto-selection reads the current value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const body: CheckRequest = {
      packageName,
      fromVersion,
      toVersion,
      targetRepoPath,
      ...(openPr
        ? { prOptions: { owner: prOwner, repo: prRepo, baseBranch: prBaseBranch } }
        : {}),
      ...(installationId ? { installationId: Number(installationId) } : {}),
    };

    try {
      await triggerCheck(body);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="default">
        Run a check
      </Button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/70 p-6 backdrop-blur"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="mt-12 w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h2 className="text-base font-semibold text-zinc-100">Run a check</h2>
        <p className="mt-1 text-xs text-zinc-400">
          Fires the full DriftGuard pipeline. Takes a few minutes — the LLM fix-draft stage
          is one call per match. The dashboard refreshes when it completes.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <Field label="Package" value={packageName} onChange={setPackageName} />
          <Field label="From" value={fromVersion} onChange={setFromVersion} mono />
          <Field label="To" value={toVersion} onChange={setToVersion} mono />
          <Field label="Target repo path" value={targetRepoPath} onChange={setTargetRepoPath} mono full />
        </div>

        <div className="mt-4 flex items-center gap-2">
          <input
            id="openpr"
            type="checkbox"
            checked={openPr}
            onChange={(e) => setOpenPr(e.target.checked)}
            className="size-4 rounded border-zinc-700 bg-zinc-900"
          />
          <label htmlFor="openpr" className="text-sm text-zinc-300">
            Open a draft PR when HIGH-confidence fixes exist
          </label>
        </div>

        {openPr ? (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Field label="Owner" value={prOwner} onChange={setPrOwner} />
            <Field label="Repo" value={prRepo} onChange={setPrRepo} />
            <Field label="Base" value={prBaseBranch} onChange={setPrBaseBranch} />
          </div>
        ) : null}

        {openPr ? (
          <div className="mt-3">
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-400">
                GitHub installation
              </span>
              <select
                value={installationId}
                onChange={(e) => setInstallationId(e.target.value)}
                className="block w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
              >
                <option value="">
                  {installations.length === 0
                    ? 'No installations connected — using PAT fallback'
                    : 'Use personal access token (fallback)'}
                </option>
                {installations.map((i) => (
                  <option key={i.githubInstallationId} value={i.githubInstallationId}>
                    {i.ownerKind === 'organization' ? '@' : ''}
                    {i.ownerGithubLogin} · {i.repos.length} repo{i.repos.length === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-zinc-500">
                Phase 2 — when set, the API uses the GitHub App token instead of GITHUB_TOKEN.
              </span>
            </label>
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Running…' : 'Run check'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  mono,
  full,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <label className={full ? 'col-span-2' : ''}>
      <span className="mb-1 block text-xs uppercase tracking-wider text-zinc-400">
        {label}
      </span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? 'font-mono' : ''}
        required
      />
    </label>
  );
}