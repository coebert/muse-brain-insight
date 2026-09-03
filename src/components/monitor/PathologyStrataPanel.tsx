import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Loader2 } from "lucide-react";

import { getPathologyStrata } from "@/lib/eeg/pathology-strata.functions";
import type { PathologyStratum } from "@/lib/eeg/pathology-strata";
import { cn } from "@/lib/utils";

const SUFFICIENCY_TONE: Record<PathologyStratum["sufficiency"], string> = {
  sufficient: "bg-signal/15 text-signal",
  provisional: "bg-caution/15 text-caution",
  insufficient: "bg-muted text-muted-foreground",
};

const SUFFICIENCY_LABEL: Record<PathologyStratum["sufficiency"], string> = {
  sufficient: "Sufficient",
  provisional: "Provisional",
  insufficient: "Too few",
};

const signed = (v: number | null | undefined, dp = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
const plain = (v: number | null | undefined, dp = 1) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="metric-value text-sm">{value}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * Pathology-stratified COEBIS evaluation: held-out bias and error for each EEG
 * pattern, regimen and clinical label, so groups the model handles badly are
 * visible instead of being averaged into a flattering pooled figure.
 */
export function PathologyStrataPanel() {
  const fetchStrata = useServerFn(getPathologyStrata);
  const [group, setGroup] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["pathology-strata"],
    queryFn: () => fetchStrata({ data: { family: "covariate" as const } }),
    staleTime: 60_000,
  });

  const groups = useMemo(() => {
    if (!data) return [] as { key: string; label: string }[];
    const seen = new Map<string, string>();
    for (const s of data.strata) seen.set(s.group, s.groupLabel);
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [data]);

  const rows = useMemo(
    () => (data ? data.strata.filter((s) => group === "all" || s.group === group) : []),
    [data, group],
  );

  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Pathology-stratified evaluation
          </h2>
        </div>
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Every paired reading is predicted by a model fitted without its own case, then grouped by
        the EEG pattern it was taken in and by the case's clinical labels. Bias is COEBIS minus the
        monitor: positive means the app reads lighter.
      </p>

      {error ? (
        <p className="mt-3 text-xs text-critical">{(error as Error).message}</p>
      ) : !data ? null : data.scored === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No held-out predictions yet — at least two cases with paired monitor readings are needed.
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Readings" value={String(data.points)} hint={`${data.cases} cases`} />
            <Stat label="Held-out bias" value={signed(data.overall.bias)} hint="all groups" />
            <Stat
              label="Held-out MAE"
              value={plain(data.overall.mae)}
              hint={`uncorrected ${plain(data.overallBefore.mae)}`}
            />
            <Stat
              label="Within ±5"
              value={data.overall.within5 == null ? "—" : `${data.overall.within5.toFixed(0)}%`}
              hint={`${data.unmatchedEpochs} without epoch match`}
            />
          </div>

          {data.weakSpots.length ? (
            <div className="mt-3 rounded-md border border-caution/40 bg-caution/10 p-3">
              <p className="text-xs font-semibold text-caution">Weakest groups</p>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {data.weakSpots.slice(0, 4).map((s) => (
                  <li key={`${s.group}-${s.level}`}>
                    <span className="text-foreground">
                      {s.groupLabel} · {s.level}
                    </span>{" "}
                    — MAE {plain(s.after.mae)} ({signed(s.maeGap)} vs overall), bias{" "}
                    {signed(s.after.bias)}, n={s.n}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {[{ key: "all", label: "All groups" }, ...groups].map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => setGroup(g.key)}
                className={cn(
                  "min-h-9 rounded-md px-2.5 py-1 text-xs",
                  group === g.key
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted",
                )}
              >
                {g.label}
              </button>
            ))}
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[46rem] text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1.5 pr-3 font-medium">Group</th>
                  <th className="py-1.5 pr-3 font-medium">n / cases</th>
                  <th className="py-1.5 pr-3 font-medium">Bias (95% CI)</th>
                  <th className="py-1.5 pr-3 font-medium">MAE</th>
                  <th className="py-1.5 pr-3 font-medium">Δ MAE</th>
                  <th className="py-1.5 pr-3 font-medium">Limits of agreement</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={`${s.group}-${s.level}`} className="border-t border-border/60 align-top">
                    <td className="py-1.5 pr-3">
                      <span className="text-foreground">{s.level}</span>
                      <span className="block text-[11px] text-muted-foreground">{s.groupLabel}</span>
                      <span className="block text-[11px] text-muted-foreground">{s.verdict}</span>
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {s.n} / {s.cases}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {signed(s.after.bias)}
                      {s.biasCi ? (
                        <span className="block text-[11px] text-muted-foreground">
                          {signed(s.biasCi.low)} to {signed(s.biasCi.high)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {plain(s.after.mae)}
                      <span className="block text-[11px] text-muted-foreground">
                        uncorrected {plain(s.before.mae)}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">{signed(s.maeGap)}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {s.limitsOfAgreement
                        ? `${signed(s.limitsOfAgreement.low)} to ${signed(s.limitsOfAgreement.high)}`
                        : "—"}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[11px]",
                          SUFFICIENCY_TONE[s.sufficiency],
                        )}
                      >
                        {SUFFICIENCY_LABEL[s.sufficiency]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
