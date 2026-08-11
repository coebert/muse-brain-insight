/**
 * Automatic drift detection for a COEBIS model version.
 *
 * A fit is made on the evidence available at the time. As new cases arrive the
 * same model can quietly stop agreeing with the commercial monitor: either the
 * residual distribution slides (systematic bias creeping in, or the spread
 * widening), or the plain share of readings within tolerance falls away.
 *
 * This compares a *baseline* window of the model's residuals — the older
 * readings — against the most *recent* window, and flags the version when the
 * shift is larger than the thresholds below. Everything is measured on observed
 * residuals, so no distributional assumption is made.
 */
import type { ResidualInput } from "./coebis-residuals";

/** Minimum readings needed in each window before a comparison means anything. */
export const MIN_WINDOW = 15;
/** Share of the readings (newest) treated as the recent window. */
const RECENT_SHARE = 0.3;
/** Percentage points of within-tolerance loss that counts as drift. */
export const PERCENT_DROP_WATCH = 8;
export const PERCENT_DROP_DRIFT = 15;
/** Absolute floor for the recent window, regardless of the baseline. */
export const PERCENT_FLOOR = 60;
/** Population stability index thresholds for the residual histogram. */
export const PSI_WATCH = 0.1;
export const PSI_DRIFT = 0.25;
/** Bias movement (index points) that counts as a distribution shift. */
export const BIAS_SHIFT_WATCH = 2;
export const BIAS_SHIFT_DRIFT = 4;

/** Coarse bins used for the stability index; finer bins make PSI too jumpy. */
const PSI_EDGES = [-Infinity, -10, -5, -2.5, 0, 2.5, 5, 10, Infinity];

export type CoebisDriftStatus = "insufficient" | "stable" | "watch" | "drifting";

export interface CoebisDriftWindow {
  n: number;
  percentWithin: number;
  bias: number | null;
  mae: number | null;
  from: string | null;
  to: string | null;
}

export interface CoebisDriftWatch {
  status: CoebisDriftStatus;
  /** Plain-language line for the badge tooltip and the alert row. */
  summary: string;
  /** Reasons that triggered the flag, most important first. */
  reasons: string[];
  tolerance: number;
  baseline: CoebisDriftWindow;
  recent: CoebisDriftWindow;
  /** recent − baseline, in percentage points. Negative = worse. */
  percentDelta: number | null;
  /** recent − baseline mean residual, in index points. */
  biasDelta: number | null;
  /** Population stability index of the residual histogram, recent vs baseline. */
  psi: number | null;
}

const r1 = (v: number) => Number(v.toFixed(1));
const r2 = (v: number) => Number(v.toFixed(2));
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

function windowStats(rows: ResidualInput[], tolerance: number): CoebisDriftWindow {
  const values = rows.map((p) => p.residual);
  const within = values.filter((v) => Math.abs(v) <= tolerance).length;
  const bias = mean(values);
  const mae = mean(values.map(Math.abs));
  const dates = rows.map((p) => p.recordedAt).sort();
  return {
    n: values.length,
    percentWithin: values.length ? Math.round((within / values.length) * 100) : 0,
    bias: bias == null ? null : r1(bias),
    mae: mae == null ? null : r1(mae),
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}

/** Population stability index between two residual distributions. */
function stabilityIndex(baseline: number[], recent: number[]): number | null {
  if (!baseline.length || !recent.length) return null;
  let psi = 0;
  for (let i = 0; i < PSI_EDGES.length - 1; i += 1) {
    const from = PSI_EDGES[i]!;
    const to = PSI_EDGES[i + 1]!;
    const inBin = (v: number) => v >= from && v < to;
    // Floor each share so an empty bin cannot send the index to infinity.
    const b = Math.max(baseline.filter(inBin).length / baseline.length, 0.001);
    const r = Math.max(recent.filter(inBin).length / recent.length, 0.001);
    psi += (r - b) * Math.log(r / b);
  }
  return r2(psi);
}

function worst(a: CoebisDriftStatus, b: CoebisDriftStatus): CoebisDriftStatus {
  const rank: Record<CoebisDriftStatus, number> = {
    insufficient: 0,
    stable: 1,
    watch: 2,
    drifting: 3,
  };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Compare the oldest readings a version was scored on against the newest, and
 * decide whether the model has drifted.
 */
export function detectCoebisDrift(
  input: ResidualInput[],
  tolerance: number,
  minWindow = MIN_WINDOW,
): CoebisDriftWatch {
  const rows = input
    .filter((p) => Number.isFinite(p.residual) && Boolean(p.recordedAt))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  const recentCount = Math.max(minWindow, Math.round(rows.length * RECENT_SHARE));
  const split = rows.length - recentCount;
  const baselineRows = split > 0 ? rows.slice(0, split) : [];
  const recentRows = split > 0 ? rows.slice(split) : rows;

  const baseline = windowStats(baselineRows, tolerance);
  const recent = windowStats(recentRows, tolerance);

  if (baseline.n < minWindow || recent.n < minWindow) {
    return {
      status: "insufficient",
      summary: `Not enough history to judge drift — ${rows.length} readings, ${minWindow} needed in each of the earlier and recent windows.`,
      reasons: [],
      tolerance,
      baseline,
      recent,
      percentDelta: null,
      biasDelta: null,
      psi: null,
    };
  }

  const percentDelta = recent.percentWithin - baseline.percentWithin;
  const biasDelta =
    recent.bias == null || baseline.bias == null ? null : r1(recent.bias - baseline.bias);
  const psi = stabilityIndex(
    baselineRows.map((p) => p.residual),
    recentRows.map((p) => p.residual),
  );

  const reasons: string[] = [];
  let status: CoebisDriftStatus = "stable";

  if (percentDelta <= -PERCENT_DROP_DRIFT) {
    status = worst(status, "drifting");
    reasons.push(
      `Within ±${tolerance} fell ${Math.abs(percentDelta)} points (${baseline.percentWithin}% → ${recent.percentWithin}%).`,
    );
  } else if (percentDelta <= -PERCENT_DROP_WATCH) {
    status = worst(status, "watch");
    reasons.push(
      `Within ±${tolerance} slipped ${Math.abs(percentDelta)} points (${baseline.percentWithin}% → ${recent.percentWithin}%).`,
    );
  }

  if (recent.percentWithin < PERCENT_FLOOR) {
    status = worst(status, recent.percentWithin < PERCENT_FLOOR - 15 ? "drifting" : "watch");
    reasons.push(
      `Only ${recent.percentWithin}% of the recent readings sit within ±${tolerance}, below the ${PERCENT_FLOOR}% floor.`,
    );
  }

  if (psi != null && psi >= PSI_DRIFT) {
    status = worst(status, "drifting");
    reasons.push(`Residual histogram has moved substantially (stability index ${psi.toFixed(2)}).`);
  } else if (psi != null && psi >= PSI_WATCH) {
    status = worst(status, "watch");
    reasons.push(`Residual histogram is shifting (stability index ${psi.toFixed(2)}).`);
  }

  if (biasDelta != null && Math.abs(biasDelta) >= BIAS_SHIFT_DRIFT) {
    status = worst(status, "drifting");
    reasons.push(
      `Mean residual moved ${biasDelta > 0 ? "+" : ""}${biasDelta} points (${baseline.bias} → ${recent.bias}).`,
    );
  } else if (biasDelta != null && Math.abs(biasDelta) >= BIAS_SHIFT_WATCH) {
    status = worst(status, "watch");
    reasons.push(
      `Mean residual moved ${biasDelta > 0 ? "+" : ""}${biasDelta} points (${baseline.bias} → ${recent.bias}).`,
    );
  }

  const summary =
    status === "stable"
      ? `Agreement is holding: ${recent.percentWithin}% of the last ${recent.n} readings within ±${tolerance}, against ${baseline.percentWithin}% earlier.`
      : status === "watch"
        ? `Agreement is slipping on recent cases — worth watching, and refitting if it continues. ${reasons[0]}`
        : `This model has drifted on recent cases; refit before relying on it. ${reasons[0]}`;

  return { status, summary, reasons, tolerance, baseline, recent, percentDelta, biasDelta, psi };
}
