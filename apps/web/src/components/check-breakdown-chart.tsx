'use client';

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Card } from '@/components/ui/card';
import type { RunHistoryEntry } from '@/lib/api';

interface CheckBreakdownChartProps {
  runs: RunHistoryEntry[];
}

const chartConfig: ChartConfig = {
  breaking: { label: 'Breaking', color: '#ef4444' },
  safe: { label: 'Safe', color: '#10b981' },
  unknown: { label: 'Unknown', color: '#71717a' },
};

/**
 * Bar chart of verdict outcomes across the run history. Three buckets:
 * breaking, safe, unknown/error. Renders an empty-state message when
 * there is no history, never zero-height bars.
 */
export function CheckBreakdownChart({ runs }: CheckBreakdownChartProps) {
  const counts = runs.reduce(
    (acc, run) => {
      if (run.verdict.error || run.verdict.breaking === null) acc.unknown += 1;
      else if (run.verdict.breaking) acc.breaking += 1;
      else acc.safe += 1;
      return acc;
    },
    { breaking: 0, safe: 0, unknown: 0 },
  );

  const data = [
    { category: 'Breaking', count: counts.breaking, fill: 'var(--color-breaking)' },
    { category: 'Safe', count: counts.safe, fill: 'var(--color-safe)' },
    { category: 'Unknown', count: counts.unknown, fill: 'var(--color-unknown)' },
  ];

  return (
    <Card className="border-zinc-800 bg-zinc-900/40 ring-1 ring-zinc-800/60">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-medium text-zinc-200">Verdict breakdown</h2>
        <p className="text-xs text-zinc-500">
          How many runs landed in each outcome.
        </p>
      </div>
      <div className="p-4">
        {runs.length === 0 ? (
          <p className="py-12 text-center text-sm text-zinc-500">
            No data yet — run your first check.
          </p>
        ) : (
          <ChartContainer config={chartConfig} className="h-56 w-full">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <CartesianGrid vertical={false} stroke="#27272a" />
              <XAxis
                dataKey="category"
                stroke="#a1a1aa"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                tickMargin={8}
              />
              <YAxis
                stroke="#a1a1aa"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                allowDecimals={false}
              />
              <ChartTooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                content={<ChartTooltipContent hideLabel />}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </div>
    </Card>
  );
}