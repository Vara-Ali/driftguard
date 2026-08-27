import { fetchMetrics, fetchRuns } from '@/lib/api';
import { MetricCard } from '@/components/metric-card';
import { RunTable } from '@/components/run-table';
import { RunCheckButton } from '@/components/run-check-button';
import { CheckBreakdownChart } from '@/components/check-breakdown-chart';

/**
 * Dashboard home — server component.
 *
 * Fetches live data from the DriftGuard API on every request. No
 * caching: the dashboard exists to show "what just happened," and a
 * stale view is worse than a slow one. `RunCheckButton` calls
 * `router.refresh()` after a successful POST so the user sees new rows
 * without a manual reload.
 */
export default async function DashboardPage() {
  const [metrics, runs] = await Promise.all([fetchMetrics(), fetchRuns()]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
            DriftGuard
          </h1>
          <p className="text-sm text-zinc-400">
            Real-time view of dependency drift checks and the draft PRs they produced.
          </p>
        </div>
        <RunCheckButton />
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Dependencies Tracked"
          value={metrics.dependenciesTracked}
          hint="Distinct packages seen in history"
        />
        <MetricCard
          title="Checks Run"
          value={metrics.checksRun}
          hint="All time, across all packages"
        />
        <MetricCard
          title="Breaking Changes Found"
          value={metrics.breakingChangesFound}
          hint="Checks where the LLM verdict said breaking"
          tone={metrics.breakingChangesFound > 0 ? 'warn' : 'neutral'}
        />
        <MetricCard
          title="PRs Opened"
          value={metrics.prsOpened}
          hint="Draft pull requests created"
          tone={metrics.prsOpened > 0 ? 'ok' : 'neutral'}
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr,1fr]">
        <RunTable runs={runs} />
        <CheckBreakdownChart runs={runs} />
      </section>
    </div>
  );
}