import { Card } from '@/components/ui/card';
import { Settings as SettingsIcon } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-400">
          DriftGuard-wide preferences. Per-installation defaults live on the Repositories page.
        </p>
      </header>

      <Card className="border-zinc-800 bg-zinc-900/40 p-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <SettingsIcon className="size-8 text-zinc-600" />
          <h2 className="text-sm font-semibold text-zinc-200">Coming soon</h2>
          <p className="max-w-md text-xs text-zinc-500">
            Global settings (LLM model override, scan noise exclusions, default PR base branch)
            land in Phase 3 alongside the Findings page.
          </p>
        </div>
      </Card>
    </div>
  );
}