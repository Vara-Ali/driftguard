import { Card } from '@/components/ui/card';
import { ListChecks } from 'lucide-react';

export default function FindingsPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Findings</h1>
        <p className="text-sm text-zinc-400">
          Per-symbol detail across all runs — which symbol was flagged, what the LLM suggested,
          and whether the human reviewer applied it.
        </p>
      </header>

      <Card className="border-zinc-800 bg-zinc-900/40 p-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <ListChecks className="size-8 text-zinc-600" />
          <h2 className="text-sm font-semibold text-zinc-200">Coming soon</h2>
          <p className="max-w-md text-xs text-zinc-500">
            Phase 3 will render the per-symbol fix detail here, grouped by package + version pair.
            For now, the run history table on the Dashboard page links out to each run's full
            Markdown report.
          </p>
        </div>
      </Card>
    </div>
  );
}