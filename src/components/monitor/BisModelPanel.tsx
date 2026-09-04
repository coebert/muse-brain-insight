/**
 * BIS model panel.
 *
 * Shows, per acquisition setup, how closely the app's published number tracks
 * the recorded bedside BIS today, and how closely the fitted BIS model tracks
 * it on cases the fit never saw. A model is only marked in force when it
 * cleared the promotion gate; everything else states plainly why it did not.
 */

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { BisFitReport, BisMetrics } from "@/lib/eeg/bis-model";
import { getBisModelReport, promoteBisModel } from "@/lib/eeg/bis-model.functions";
import { describeLineage, parseLineageKey } from "@/lib/eeg/model-lineage";
import { useState } from "react";

/** Plain-language name for an acquisition setup. */
function lineageLabel(key: string): string {
  const parsed = parseLineageKey(key);
  return parsed ? describeLineage(parsed) : key;
}

function num(v: number | null | undefined, dp = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}

function MetricRow({ label, m, hint }: { label: string; m: BisMetrics | null; hint: string }) {
  return (
    <tr className="border-t border-border/60">
      <th scope="row" className="py-2 pr-3 text-left font-medium">
        {label}
        <span className="block text-xs font-normal text-muted-foreground">{hint}</span>
      </th>
      <td className="py-2 pr-3 text-right tabular-nums">{num(m?.mae)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{num(m?.bias)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{num(m?.correlation, 3)}</td>
      <td className="py-2 text-right tabular-nums">
        {m ? `${Math.round(m.within5 * 100)}%` : "—"}
      </td>
    </tr>
  );
}

function FitCard({ fit, active }: { fit: BisFitReport; active: boolean }) {
  return (
    <article className="panel p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{lineageLabel(fit.lineage)}</h3>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            active
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {active ? "in force" : "not in force"}
        </span>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        {fit.points.toLocaleString()} bedside readings across {fit.cases} cases, graded on{" "}
        {fit.folds} held-out groups.
      </p>

      <table className="mt-3 w-full text-sm">
        <caption className="sr-only">
          Accuracy against the recorded bedside BIS on {lineageLabel(fit.lineage)}
        </caption>
        <thead>
          <tr className="text-xs tracking-wide text-muted-foreground uppercase">
            <th scope="col" className="pb-1 text-left">
              Estimate
            </th>
            <th scope="col" className="pb-1 text-right">
              Avg error
            </th>
            <th scope="col" className="pb-1 text-right">
              Bias
            </th>
            <th scope="col" className="pb-1 text-right">
              Correlation
            </th>
            <th scope="col" className="pb-1 text-right">
              Within 5
            </th>
          </tr>
        </thead>
        <tbody>
          <MetricRow label="What the app says today" m={fit.before} hint="COEBIS, or the raw index where no version is in force" />
          <MetricRow label="BIS model" m={fit.after} hint="held out: no case grades its own fit" />
          <MetricRow label="BIS model, in sample" m={fit.inSample} hint="reference only, flatters the fit" />
        </tbody>
      </table>

      <p className="mt-3 text-sm">
        {fit.maeGain == null ? (
          <span className="text-muted-foreground">{fit.blockedBy}</span>
        ) : fit.promotable ? (
          <span className="text-primary">
            Closer to the monitor by {num(fit.maeGain)} points on cases it never saw.
          </span>
        ) : (
          <span className="text-muted-foreground">Not promoted — {fit.blockedBy}.</span>
        )}
      </p>
      {fit.terms.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Reads from: depth index, spectral edge and suppression ratio ({fit.terms.length - 1} fitted
          terms).
        </p>
      ) : null}
    </article>
  );
}

export function BisModelPanel() {
  const fetchReport = useServerFn(getBisModelReport);
  const runPromotion = useServerFn(promoteBisModel);
  const [busy, setBusy] = useState(false);

  const query = useQuery({
    queryKey: ["bis-model-report"],
    queryFn: () => fetchReport({ data: {} }),
    staleTime: 60_000,
  });

  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Fitting against the bedside readings…
      </p>
    );
  }
  if (query.error) {
    return (
      <p role="alert" className="p-4 text-sm text-critical">
        {(query.error as Error).message}
      </p>
    );
  }

  const report = query.data;
  if (!report) return null;
  const activeLineages = new Set(report.active.map((a) => a.lineage));

  return (
    <section className="space-y-4" aria-label="BIS model">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Fitted on {report.totalPoints.toLocaleString()} paired bedside readings across{" "}
          {report.totalCases} cases. {report.active.length} model
          {report.active.length === 1 ? "" : "s"} in force.
        </p>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await runPromotion({ data: { note: "manual refit" } });
              await query.refetch();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
          Refit and promote
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {report.fits.map((fit) => (
          <FitCard key={fit.lineage} fit={fit} active={activeLineages.has(fit.lineage)} />
        ))}
      </div>
    </section>
  );
}
