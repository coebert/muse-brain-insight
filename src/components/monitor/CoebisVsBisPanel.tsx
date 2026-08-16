import { useMemo } from "react";
import { GitCompareArrows } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatClock } from "@/lib/eeg/format";
import type { Epoch } from "@/lib/eeg/analysis";
import { bisBandLabel, type BisReading } from "@/lib/eeg/bis";
import { applyBisAlignment, type BisAlignment } from "@/lib/eeg/depth";
import { covariateAdjustment, type CaseCovariates } from "@/lib/eeg/covariates";
import type { MonitorEntropy } from "@/lib/eeg/entropy-monitor";
import type { AdjunctCorrection } from "@/lib/eeg/coebis-adjuncts";
import { cn } from "@/lib/utils";

/** Which tier of the COEBIS hierarchy the live model represents. */
function tierOf(model: BisAlignment | null): { tier: "A" | "B" | "C"; label: string } {
  const family = (model?.family ?? "affine").toLowerCase();
  const hasTerms = Boolean(model?.terms?.length);
  if (family.includes("mixed")) return { tier: "C", label: "Tier C · mixed effects" };
  if (hasTerms || family.includes("covariate")) return { tier: "B", label: "Tier B · patient-adjusted" };
  return { tier: "A", label: "Tier A · pooled" };
}

function fmt(v: number | null | undefined, dp = 0): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}

function signed(v: number | null, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
}

/** Nearest epoch to a case-clock time, within a tolerance. */
function epochAt(epochs: Epoch[], t: number, tolerance = 20): Epoch | null {
  let best: Epoch | null = null;
  let bestGap = Infinity;
  for (const e of epochs) {
    const gap = Math.abs(e.t - t);
    if (gap < bestGap) {
      bestGap = gap;
      best = e;
    }
  }
  return bestGap <= tolerance ? best : null;
}

/**
 * Side-by-side reconciliation of the tiered, patient-adjusted COEBIS value
 * against the commercial BIS monitor running on the same patient. It shows the
 * two numbers together, the pooled (tier A) value the patient terms started
 * from, and whether those terms moved COEBIS towards or away from the monitor
 * across the readings logged so far in this case.
 */
export function CoebisVsBisPanel({
  epochs,
  readings,
  openIbis,
  model,
  covariates,
  entropy,
  adjunct,
  className,
}: {
  epochs: Epoch[];
  readings: BisReading[];
  /** Live raw OpenIBIS index. */
  openIbis: number | null;
  model: BisAlignment | null;
  covariates: CaseCovariates | null;
  /** Entropy-monitor style SE/RE for the epoch on screen. */
  entropy?: MonitorEntropy | null;
  /** Entropy/PSI-informed adjunct folded into the live COEBIS value. */
  adjunct?: AdjunctCorrection | null;
  className?: string;
}) {
  const tier = tierOf(model);

  const live = useMemo(() => {
    if (openIbis == null || !model) return { tiered: null, pooled: null };
    return {
      tiered: applyBisAlignment(openIbis, model, covariates, adjunct?.total ?? 0),
      pooled: applyBisAlignment(openIbis, model, null),
    };
  }, [openIbis, model, covariates, adjunct?.total]);

  const adjustment = useMemo(
    () => covariateAdjustment(model?.terms, covariates ?? null),
    [model?.terms, covariates],
  );

  const lastReading = useMemo(
    () => (readings.length ? [...readings].sort((a, b) => a.at - b.at)[readings.length - 1]! : null),
    [readings],
  );

  /** Paired COEBIS/BIS values across this case, for agreement so far. */
  const pairs = useMemo(() => {
    if (!model) return [];
    const out: { at: number; bis: number; tiered: number; pooled: number }[] = [];
    for (const r of readings) {
      const e = epochAt(epochs, r.at);
      const raw = e?.depth.index ?? null;
      if (raw == null) continue;
      out.push({
        at: r.at,
        bis: r.bis,
        tiered: applyBisAlignment(raw, model, covariates),
        pooled: applyBisAlignment(raw, model, null),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [readings, epochs, model, covariates]);

  const agreement = useMemo(() => {
    if (!pairs.length) return null;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      n: pairs.length,
      biasTiered: mean(pairs.map((p) => p.tiered - p.bis)),
      biasPooled: mean(pairs.map((p) => p.pooled - p.bis)),
      maeTiered: mean(pairs.map((p) => Math.abs(p.tiered - p.bis))),
      maePooled: mean(pairs.map((p) => Math.abs(p.pooled - p.bis))),
    };
  }, [pairs]);

  const liveDelta =
    live.tiered != null && lastReading ? live.tiered - lastReading.bis : null;
  const deltaTone =
    liveDelta == null
      ? "text-muted-foreground"
      : Math.abs(liveDelta) <= 5
        ? "text-[color:var(--signal,theme(colors.emerald.400))]"
        : Math.abs(liveDelta) <= 10
          ? "text-amber-400"
          : "text-destructive";

  return (
    <section
      className={cn("rounded-lg border border-border bg-card/60 p-3", className)}
      aria-label="COEBIS versus commercial BIS"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="size-4 text-muted-foreground" />
          <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
            COEBIS vs commercial BIS
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {tier.label}
          </Badge>
          {model ? (
            <Badge variant="secondary" className="text-[10px]">
              {model.version ? `v${model.version}` : "v?"}
              {model.provisional ? " · provisional" : ""}
            </Badge>
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-3 items-end gap-2">
        <div>
          <p className="text-[10px] tracking-wide text-muted-foreground uppercase">COEBIS</p>
          <p className="metric-value text-3xl leading-none">{fmt(live.tiered)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {covariates && adjustment.total !== 0
              ? `pooled ${fmt(live.pooled)} ${signed(adjustment.total)} patient`
              : "pooled correction only"}
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] tracking-wide text-muted-foreground uppercase">Difference</p>
          <p className={cn("metric-value text-2xl leading-none", deltaTone)}>
            {signed(liveDelta)}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {lastReading ? `vs reading at ${formatClock(lastReading.at)}` : "no BIS reading yet"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
            Commercial BIS
          </p>
          <p className="metric-value text-3xl leading-none">{fmt(lastReading?.bis ?? null)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {lastReading ? `${lastReading.device ?? "BIS"} · ${bisBandLabel(lastReading.bis)}` : "—"}
          </p>
        </div>
      </div>

      {agreement ? (
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-md border border-border/70 p-2">
            <p className="text-muted-foreground">Patient-adjusted ({agreement.n} pairs)</p>
            <p className="metric-value">
              bias {signed(agreement.biasTiered)} · MAE {fmt(agreement.maeTiered, 1)}
            </p>
          </div>
          <div className="rounded-md border border-border/70 p-2">
            <p className="text-muted-foreground">Pooled (tier A)</p>
            <p className="metric-value">
              bias {signed(agreement.biasPooled)} · MAE {fmt(agreement.maePooled, 1)}
            </p>
          </div>
          <p className="col-span-2 text-[10px] text-muted-foreground">
            {agreement.maeTiered < agreement.maePooled - 0.1
              ? `Patient terms are closer to the monitor by ${(agreement.maePooled - agreement.maeTiered).toFixed(1)} points in this case.`
              : agreement.maeTiered > agreement.maePooled + 0.1
                ? `Patient terms are further from the monitor by ${(agreement.maeTiered - agreement.maePooled).toFixed(1)} points in this case — treat the adjustment with caution.`
                : "Patient terms make no material difference in this case so far."}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Log a commercial BIS reading while the index is reliable to start the
          case-level comparison.
        </p>
      )}

      {entropy?.se != null ? (
        <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-md border border-border/70 p-2">
            <p className="text-muted-foreground">State Entropy</p>
            <p className="metric-value">{entropy.se.toFixed(0)}</p>
          </div>
          <div className="rounded-md border border-border/70 p-2">
            <p className="text-muted-foreground">Response Entropy</p>
            <p className="metric-value">{entropy.re?.toFixed(0) ?? "—"}</p>
          </div>
          <div className="rounded-md border border-border/70 p-2">
            <p className="text-muted-foreground">Adjunct applied</p>
            <p className="metric-value">{signed(adjunct?.total ?? 0)}</p>
          </div>
          <p className="col-span-3 text-[10px] text-muted-foreground">
            RE−SE {signed(entropy.emgGap)} points of frontal EMG/arousal margin.
            COEBIS folds this, the suppression ceiling and the bilateral
            spectral pattern into the adjunct above.
          </p>
        </div>
      ) : null}

      {pairs.length ? (
        <div className="mt-3 overflow-hidden rounded-md border border-border/70">
          <table className="w-full text-[11px]">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-1.5 text-left font-normal">Time</th>
                <th className="p-1.5 text-right font-normal">COEBIS</th>
                <th className="p-1.5 text-right font-normal">Pooled</th>
                <th className="p-1.5 text-right font-normal">BIS</th>
                <th className="p-1.5 text-right font-normal">Δ</th>
              </tr>
            </thead>
            <tbody>
              {pairs.slice(0, 5).map((p) => (
                <tr key={p.at} className="border-t border-border/60">
                  <td className="p-1.5">{formatClock(p.at)}</td>
                  <td className="metric-value p-1.5 text-right">{fmt(p.tiered)}</td>
                  <td className="metric-value p-1.5 text-right opacity-70">{fmt(p.pooled)}</td>
                  <td className="metric-value p-1.5 text-right">{p.bis}</td>
                  <td className="metric-value p-1.5 text-right">{signed(p.tiered - p.bis)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
