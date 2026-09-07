import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, Scale } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  getRefitOverview,
  runRefitNow,
  type RefitRunRow,
} from "@/lib/eeg/coebis-refit.functions";
import { runRefitToCompletion } from "@/lib/eeg/refit-passes";
import type { LineageRefitRecord } from "@/lib/eeg/coebis-refit.server";
import { describeLineage, parseLineageKey } from "@/lib/eeg/model-lineage";
import { cn } from "@/lib/utils";

/** Held-out improvement a candidate must show before it takes over. */
const MAE_BAR = 0.25;

const num = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
const signed = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}%`;

function lineageLabel(key: string): string {
  const parsed = parseLineageKey(key);
  return parsed ? describeLineage(parsed) : key;
}

/**
 * COEBIS calibration, fitted on the recorded bedside numbers themselves.
 *
 * Each acquisition setup gets its own fit, graded only on patients the fit
 * never saw. The candidate is shown beside whatever is in force today, so a
 * refit that fails to beat the incumbent is as visible as one that wins.
 */
export function BedsideCalibrationPanel() {
  const fetchOverview = useServerFn(getRefitOverview);
  const runNow = useServerFn(runRefitNow);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["coebis-refit-overview"],
    queryFn: () => fetchOverview(),
    staleTime: 30_000,
  });

  const [progress, setProgress] = useState<string | null>(null);

  const refit = useMutation({
    // The work is done in small passes, each one a short request, so a large
    // pool can never run the server out of processing time.
    mutationFn: () =>
      runRefitToCompletion(
        () => runNow(),
        (p) =>
          setProgress(
            p.remaining > 0
              ? `Working through the setups — ${p.remaining} left`
              : `Finished ${p.lineagesRefitted} setup${p.lineagesRefitted === 1 ? "" : "s"}`,
          ),
      ),
    onSuccess: (result) => {
      if (result.status === "failed") toast.error(result.error ?? "Calibration run failed");
      else toast.success(result.summary || "Calibration run complete");
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: ["coebis-refit-overview"] });
    },
    onError: (err: Error) => {
      setProgress(null);
      toast.error(err.message);
    },
  });

  // A scheduled run that is still in flight carries no detail yet, so fall
  // back to the newest run that actually graded something.
  const run: RefitRunRow | null =
    (data?.runs ?? []).find((r: RefitRunRow) => (r.detail?.length ?? 0) > 0) ?? null;
  const detail = (run?.detail ?? []) as LineageRefitRecord[];
  const rows = [...detail].sort((a, b) => b.n - a.n);
  const activeByLineage = new Map(
    (data?.lineages ?? []).map((l) => [l.lineageKey, l.activeVersion] as const),
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Scale className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Calibration against the bedside monitor</h2>
            <p className="max-w-2xl text-xs text-muted-foreground">
              Every paired reading held is fitted per acquisition setup and graded on patients
              the fit never saw. A candidate only takes over when it cuts the held-out error by
              at least {MAE_BAR.toFixed(2)} index points.
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => refit.mutate()} disabled={refit.isPending}>
          {refit.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          Refit and promote
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-critical">{(error as Error).message}</p>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the calibration runs…
        </div>
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">
          No calibration run has been recorded yet. Run one to compare every setup against the
          recorded bedside numbers.
        </p>
      ) : (
        <>
          {run ? (
            <p className="text-xs text-muted-foreground">
              Last run {new Date(run.startedAt).toLocaleString()} ·{" "}
              {run.validatedPoints.toLocaleString()} readings passed validation ·{" "}
              {run.modelsPromoted} model{run.modelsPromoted === 1 ? "" : "s"} promoted.
            </p>
          ) : null}
          <div className="grid gap-3">
            {rows.map((r) => (
              <FitCard
                key={r.lineageKey}
                record={r}
                activeVersion={activeByLineage.get(r.lineageKey) ?? null}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function FitCard({
  record,
  activeVersion,
}: {
  record: LineageRefitRecord;
  activeVersion: number | null;
}) {
  const gain = record.maeGain;
  return (
    <div className="panel space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{lineageLabel(record.lineageKey)}</h3>
          <p className="text-xs text-muted-foreground">
            {record.n.toLocaleString()} paired readings across {record.cases} case
            {record.cases === 1 ? "" : "s"}
            {record.folds ? ` · ${record.folds} held-out folds` : ""}
            {activeVersion ? ` · calibration v${activeVersion} in force` : " · no calibration in force"}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            record.promoted
              ? "bg-emerald-500/15 text-emerald-600"
              : "bg-muted text-muted-foreground",
          )}
        >
          {record.promoted ? "Promoted" : "Kept the current model"}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 pr-3 text-left font-medium">Estimate</th>
              <th className="py-1.5 pr-3 text-right font-medium">Avg error</th>
              <th className="py-1.5 pr-3 text-right font-medium">Bias</th>
              <th className="py-1.5 pr-3 text-right font-medium">Within 5</th>
              <th className="py-1.5 pr-3 text-right font-medium">Within 10</th>
              <th className="py-1.5 text-right font-medium">Agreement</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="py-1.5 pr-3">
                <div className="font-medium">In force today</div>
                <div className="text-[11px] text-muted-foreground">
                  {record.beforeSource === "incumbent"
                    ? "the promoted calibration"
                    : "the raw index, uncalibrated"}
                </div>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{num(record.before.mae)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{signed(record.before.bias)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{pct(record.before.within5)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{pct(record.before.within10)}</td>
              <td className="py-1.5 text-right tabular-nums">{num(record.before.ccc, 3)}</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-3">
                <div className="font-medium">New candidate</div>
                <div className="text-[11px] text-muted-foreground">
                  read on exactly the same readings
                </div>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{num(record.after.mae)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{signed(record.after.bias)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{pct(record.after.within5)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{pct(record.after.within10)}</td>
              <td className="py-1.5 text-right tabular-nums">{num(record.after.ccc, 3)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Held-out error moves by {signed(gain)} points against the {MAE_BAR.toFixed(2)}-point bar.{" "}
        {record.reason}
      </p>
    </div>
  );
}
