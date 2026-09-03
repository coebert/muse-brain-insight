/**
 * Drift of the live COEBIS fit against the original fit for each lineage.
 *
 * Sits next to version history: history shows the last step, this shows the
 * cumulative distance travelled since the first model the lineage ever had.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Loader2 } from "lucide-react";

import { getRefitOverview } from "@/lib/eeg/coebis-refit.functions";
import { driftOverview, type DriftStatus } from "@/lib/eeg/coebis-drift";
import { explainDriftGaps } from "@/lib/eeg/metric-blockers";
import { cn } from "@/lib/utils";

const plain = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
const signed = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;

const STATUS_LABEL: Record<DriftStatus, string> = {
  baseline: "Baseline only",
  stable: "Stable",
  watch: "Watch",
  drifted: "Drifted",
  regressed: "Regressed",
};

const STATUS_CLASS: Record<DriftStatus, string> = {
  baseline: "text-muted-foreground",
  stable: "text-success",
  watch: "text-warning",
  drifted: "text-warning",
  regressed: "text-critical",
};

export function ModelDriftPanel() {
  const fetchOverview = useServerFn(getRefitOverview);
  const { data, isLoading, error } = useQuery({
    queryKey: ["coebis-refit-overview"],
    queryFn: () => fetchOverview(),
    staleTime: 30_000,
  });

  const rows = data ? driftOverview(data.lineages) : [];

  return (
    <section className="panel p-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Model drift vs original fit
        </h2>
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        For each acquisition lineage, the model currently in force is compared with the first fit
        that lineage ever had — held-out error and bias, plus how far the fitted weights have moved.
        Drift is not automatically bad; a regression against the original fit is.
      </p>

      {error ? <p className="mt-3 text-xs text-critical">{(error as Error).message}</p> : null}

      {data && rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No model versions recorded yet, so there is no baseline to drift from.
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        {rows.map((d) => (
          <div key={d.lineageKey} className="rounded-md border border-border/60 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-foreground">{d.lineageKey}</p>
              <span className={cn("text-[11px] font-medium", STATUS_CLASS[d.status])}>
                {STATUS_LABEL[d.status]}
                {d.refits > 0 ? ` · ${d.refits} refit${d.refits === 1 ? "" : "s"} since baseline` : ""}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Δ MAE</p>
                <p className="text-sm text-foreground">{signed(d.maeDelta)}</p>
                <p className="text-[10px] text-muted-foreground">
                  {plain(d.baselineMae)} → {plain(d.currentMae)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Δ bias</p>
                <p className="text-sm text-foreground">{signed(d.biasDelta)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Δ CCC</p>
                <p className="text-sm text-foreground">{signed(d.cccDelta, 3)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Weight drift
                </p>
                <p className="text-sm text-foreground">{plain(d.maxWeightDrift)}</p>
                <p className="text-[10px] text-muted-foreground">
                  rms {plain(d.rmsWeightDrift)}
                </p>
              </div>
            </div>
            {d.topMovers.length ? (
              <table className="mt-2 w-full text-[11px]">
                <tbody>
                  {d.topMovers.map((m) => (
                    <tr key={m.id} className="border-t border-border/40">
                      <td className="py-1 pr-2 text-muted-foreground">{m.label}</td>
                      <td className="py-1 text-right tabular-nums text-foreground">
                        {plain(m.from, 3)} → {plain(m.to, 3)}
                      </td>
                      <td className="w-16 py-1 text-right tabular-nums text-muted-foreground">
                        {signed(m.delta, 3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <p className="mt-2 text-[11px] text-muted-foreground">{d.note}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
