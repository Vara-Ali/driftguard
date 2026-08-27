import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger';

const TONE_STYLES: Record<Tone, string> = {
  neutral: 'text-zinc-100',
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  danger: 'text-red-400',
};

interface MetricCardProps {
  title: string;
  value: number;
  hint?: string;
  tone?: Tone;
}

/**
 * Single dashboard metric tile. Pure presentational component — the
 * caller computes `value` from the API. No skeletons, no loading state:
 * the dashboard page is a server component and renders the resolved
 * value or fails the render. Honest emptiness is the empty metric card
 * showing `0`, which is what `computeMetrics` returns when the history
 * file doesn't exist yet.
 */
export function MetricCard({ title, value, hint, tone = 'neutral' }: MetricCardProps) {
  return (
    <Card className="border-zinc-800 bg-zinc-900/50 ring-1 ring-zinc-800/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-zinc-400">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn('font-mono text-3xl font-semibold tabular-nums', TONE_STYLES[tone])}>
          {value}
        </div>
        {hint ? (
          <p className="mt-2 text-xs text-zinc-500">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}