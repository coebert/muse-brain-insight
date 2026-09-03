/**
 * COEBIS drift detection (pure helpers).
 *
 * Version history answers "what changed last time". Drift answers the slower
 * question: how far has the model in force wandered from the original fit for
 * the same acquisition lineage? Two kinds of movement matter clinically:
 *
 *  - performance drift — held-out MAE, bias and CCC against the baseline fit,
 *  - weight drift — how far the fitted terms themselves have moved.
 *
 * Nothing here refits or promotes. Baseline is always the oldest recorded
 * version of the lineage, so the comparison is stable as history grows.
 */

import { describeWeights, type ModelWeight } from "./coebis-version-history";
import type { ModelVersionRow, LineageHistory } from "./coebis-refit.functions";

/** Weight movement above this (index points) is worth a reviewer's attention. */
export const WEIGHT_DRIFT_WATCH = 1.5;
/** Weight movement above this means the model has meaningfully re-shaped. */
export const WEIGHT_DRIFT_HIGH = 4;
/** Held-out MAE worsening by more than this against baseline is a regression. */
export const MAE_REGRESSION = 0.5;

export type DriftStatus = "baseline" | "stable" | "watch" | "drifted" | "regressed";

export interface LineageDrift {
  lineageKey: string;
  baseline: ModelVersionRow | null;
  current: ModelVersionRow | null;
  /** Versions recorded since the baseline (excludes the baseline itself). */
  refits: number;
  status: DriftStatus;
  /** current MAE − baseline MAE; negative is an improvement. */
  maeDelta: number | null;
  biasDelta: number | null;
  cccDelta: number | null;
  baselineMae: number | null;
  currentMae: number | null;
  /** Largest absolute weight movement, in that weight's own unit. */
  maxWeightDrift: number | null;
  /** Root-mean-square movement across shared weights. */
  rmsWeightDrift: number | null;
  /** Terms that moved most, biggest first. */
  topMovers: { id: string; label: string; from: number | null; to: number | null; delta: number | null }[];
  note: string;
}

const num = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : v;

const round = (v: number, dp = 2) => Number(v.toFixed(dp));

/** Held-out metric for a version, falling back to its `before` when unscored. */
function heldOut(v: ModelVersionRow | null, key: "mae" | "bias" | "ccc"): number | null {
  if (!v) return null;
  return num(v.after?.[key]) ?? num(v.before?.[key]);
}

function weightMap(v: ModelVersionRow | null): Map<string, ModelWeight> {
  if (!v) return new Map();
  return new Map(describeWeights(v.modelFamily, v.coefficients).map((w) => [w.id, w]));
}

/**
 * Compare one lineage's current model against its original fit.
 * Versions may arrive in any order; the oldest by version number is baseline.
 */
export function lineageDrift(history: LineageHistory): LineageDrift {
  const ordered = [...history.versions].sort((a, b) => a.version - b.version);
  const baseline = ordered[0] ?? null;
  const current =
    ordered.filter((v) => v.isActive).pop() ?? ordered[ordered.length - 1] ?? null;

  const base: LineageDrift = {
    lineageKey: history.lineageKey,
    baseline,
    current,
    refits: Math.max(ordered.length - 1, 0),
    status: "baseline",
    maeDelta: null,
    biasDelta: null,
    cccDelta: null,
    baselineMae: heldOut(baseline, "mae"),
    currentMae: heldOut(current, "mae"),
    maxWeightDrift: null,
    rmsWeightDrift: null,
    topMovers: [],
    note: "",
  };

  if (!baseline || !current || baseline.id === current.id) {
    base.note = baseline
      ? "Only the original fit exists for this lineage — nothing to drift against yet."
      : "No model versions recorded for this lineage yet.";
    return base;
  }

  const bMae = heldOut(baseline, "mae");
  const cMae = heldOut(current, "mae");
  const bBias = heldOut(baseline, "bias");
  const cBias = heldOut(current, "bias");
  const bCcc = heldOut(baseline, "ccc");
  const cCcc = heldOut(current, "ccc");
  base.maeDelta = bMae != null && cMae != null ? round(cMae - bMae) : null;
  base.biasDelta = bBias != null && cBias != null ? round(cBias - bBias) : null;
  base.cccDelta = bCcc != null && cCcc != null ? round(cCcc - bCcc, 3) : null;

  const before = weightMap(baseline);
  const after = weightMap(current);
  const ids = new Set([...before.keys(), ...after.keys()]);
  const movers: LineageDrift["topMovers"] = [];
  let sumSq = 0;
  let max = 0;
  for (const id of ids) {
    const from = before.get(id)?.value ?? null;
    const to = after.get(id)?.value ?? null;
    const delta = from != null && to != null ? round(to - from, 3) : null;
    const magnitude = delta != null ? Math.abs(delta) : Math.abs(to ?? from ?? 0);
    sumSq += magnitude * magnitude;
    max = Math.max(max, magnitude);
    movers.push({
      id,
      label: after.get(id)?.label ?? before.get(id)?.label ?? id,
      from,
      to,
      delta,
    });
  }
  if (ids.size) {
    base.maxWeightDrift = round(max, 3);
    base.rmsWeightDrift = round(Math.sqrt(sumSq / ids.size), 3);
  }
  base.topMovers = movers
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 5);

  if (base.maeDelta != null && base.maeDelta > MAE_REGRESSION) {
    base.status = "regressed";
    base.note = `Held-out error is ${base.maeDelta.toFixed(2)} points worse than the original fit — review before trusting the live model.`;
  } else if ((base.maxWeightDrift ?? 0) >= WEIGHT_DRIFT_HIGH) {
    base.status = "drifted";
    base.note = `Weights have moved up to ${base.maxWeightDrift?.toFixed(2)} from the original fit; error is not worse, but the model has re-shaped.`;
  } else if ((base.maxWeightDrift ?? 0) >= WEIGHT_DRIFT_WATCH) {
    base.status = "watch";
    base.note = "Moderate weight movement against the original fit — worth watching over the next refits.";
  } else {
    base.status = "stable";
    base.note = "Close to the original fit in both weights and held-out error.";
  }
  return base;
}

/** Drift for every lineage, most-drifted first. */
export function driftOverview(lineages: LineageHistory[]): LineageDrift[] {
  const order: Record<DriftStatus, number> = {
    regressed: 0,
    drifted: 1,
    watch: 2,
    stable: 3,
    baseline: 4,
  };
  return lineages
    .map(lineageDrift)
    .sort((a, b) => order[a.status] - order[b.status] || (b.maxWeightDrift ?? 0) - (a.maxWeightDrift ?? 0));
}
