import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { verdictLabel, formatRelativeTime, type RunHistoryEntry } from '@/lib/api';

interface RunTableProps {
  runs: RunHistoryEntry[];
  /** Optional override for the empty-state copy. */
  emptyMessage?: string;
}

/**
 * Run history table. Server component — no interactivity beyond the
 * anchor tag. The empty state is a single full-width row reading the
 * exact phrase from the brief: "No checks yet — run your first check to
 * see results here". Never shows a fake row, never auto-populates.
 *
 * Verdict badge: red for breaking, emerald for safe, zinc for unknown
 * / error. Confidence sub-text is rendered as a small slate label
 * inside the badge so the column stays scannable.
 */
export function RunTable({ runs, emptyMessage }: RunTableProps) {
  return (
    <Card className="border-zinc-800 bg-zinc-900/40 ring-1 ring-zinc-800/60">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-medium text-zinc-200">Recent checks</h2>
        <p className="text-xs text-zinc-500">
          Newest first. Limited to the last {runs.length} run{runs.length === 1 ? '' : 's'}.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="border-zinc-800 hover:bg-transparent">
            <TableHead className="text-zinc-400">Package</TableHead>
            <TableHead className="text-zinc-400">Version Change</TableHead>
            <TableHead className="text-zinc-400">Verdict</TableHead>
            <TableHead className="text-zinc-400">Checked</TableHead>
            <TableHead className="text-right text-zinc-400">PR</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 ? (
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableCell colSpan={5} className="py-10 text-center text-sm text-zinc-500">
                {emptyMessage ?? 'No checks yet — run your first check to see results here'}
              </TableCell>
            </TableRow>
          ) : (
            runs.map((run) => {
              const verdict = verdictLabel(run);
              return (
                <TableRow
                  key={run.runId}
                  className="border-zinc-800 transition-colors hover:bg-zinc-900/60"
                >
                  <TableCell className="font-mono text-sm text-zinc-100">
                    {run.packageName}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-zinc-300">
                    <span className="text-zinc-400">{run.fromVersion}</span>
                    <span className="px-1 text-zinc-600">→</span>
                    <span className="text-zinc-100">{run.toVersion}</span>
                  </TableCell>
                  <TableCell>
                    <VerdictBadge verdict={verdict} confidence={run.verdict.confidence} />
                  </TableCell>
                  <TableCell className="text-xs text-zinc-400" title={run.startedAt}>
                    {formatRelativeTime(run.startedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {run.pr?.prUrl ? (
                      <Link
                        href={run.pr.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-emerald-400 hover:text-emerald-300 hover:underline"
                      >
                        #{run.pr.prNumber ?? '?'}
                      </Link>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

function VerdictBadge({
  verdict,
  confidence,
}: {
  verdict: ReturnType<typeof verdictLabel>;
  confidence: RunHistoryEntry['verdict']['confidence'];
}) {
  if (verdict.tone === 'breaking') {
    return (
      <Badge variant="destructive" className="font-mono uppercase tracking-wide">
        breaking{confidence ? ` · ${confidence}` : ''}
      </Badge>
    );
  }
  if (verdict.tone === 'safe') {
    return (
      <Badge className="border-transparent bg-emerald-500/15 font-mono uppercase tracking-wide text-emerald-400 hover:bg-emerald-500/20">
        safe{confidence ? ` · ${confidence}` : ''}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-mono uppercase tracking-wide">
      {verdict.label}
    </Badge>
  );
}