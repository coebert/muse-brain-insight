/**
 * Long-term surveillance of how the app's open depth index compares with the
 * commercial BIS values transcribed at the bedside, pooled across every case.
 *
 * A single case rarely has enough paired readings to say anything about a
 * systematic offset. Pooling them lets the app watch for a persistent bias
 * (the open index reading consistently lighter or deeper than the monitor) and,
 * once the evidence is strong enough, fit a gain/offset correction that maps
 * the open index onto the commercial scale.
 *
 * The correction is deliberately conservative: it is a monotone affine map of
 * the final index, never a change to the published openibis subparameters, and
 * it is shrunk toward the identity so a small sample cannot rescale the index.
 * The app still never computes BIS — this only aligns the trend.
 */

import { pearson } from "./correlation";
import { BIS_BANDS } from "./bis";
import { knotCorrection, type BisKnot } from "./depth";
import { clusterRobustMeanCi } from "./ci";
import { TRANSITIONAL_WEIGHT, type PairStability } from "./pairing-lag";

/** One pooled comparison point, from any case. */
export interface BisDriftPoint {
  /** Case-clock seconds within its own case. */
  at: number;
  bis: number;
  appIndex: number;
  sessionId: string | null;
  reliable: boolean;
  sqi: number | null;
  /** ISO timestamp the point was filed. */
  recordedAt: string;
  context?: string | null;
  /**
   * Was depth steady when the reading was taken? A transitional reading is
   * paired against a monitor value that reflects a different moment, so it
   * carries a lag error and counts for less.
   */
  stability?: PairStability;
  /** Index points per minute around the reading, when the trend was recorded. */
  slopePerMin?: number | null;
  /** Seconds the app index was shifted back before pairing, if any. */
  lagAppliedSeconds?: number | null;
}

export interface BisDriftBand {
  band: string;
  n: number;
  bias: number | null;
  meanAbsolute: number | null;
}

/** BIS ≈ gain × appIndex + offset. */
export interface BisAlignmentFit {
  gain: number;
  offset: number;
  /** Residual corrections that finesse the affine map, COEBIS model v2. */
  knots: BisKnot[];
  /** Points the fit was made on. */
  n: number;
  sessions: number;
  biasBefore: number;
  biasAfter: number;
  maeBefore: number;
  maeAfter: number;
}

export type DriftVerdict =
  | "insufficient"
  | "watching"
  | "provisional"
  | "aligned"
  | "adjust"
  | "adjustment_active";

export interface BisDriftAnalysis {
  n: number;
  /** Points the app judged reliable at the time; the fit uses these when it can. */
  nReliable: number;
  sessions: number;
  /** Mean (app index − BIS); positive = the app reads lighter than the monitor. */
  bias: number | null;
  sd: number | null;
  /** 95 % confidence interval of the bias. */
  ci: [number, number] | null;
  /**
   * How much the clustering of readings within cases inflates the interval.
   * 1.0 means the readings behaved as independent observations.
   */
  designEffect: number | null;
  /** Share of the disagreement explained by which case a reading came from. */
  icc: number | null;
  /** Readings taken while depth was moving, which carry a monitor-lag error. */
  nTransitional: number;
  mae: number | null;
  r: number | null;
  bands: BisDriftBand[];
  /** Bias over the most recent 60 points, to spot a drift that is changing. */
  recent: { n: number; bias: number | null };
  fit: BisAlignmentFit | null;
  verdict: DriftVerdict;
  /**
   * How much weight the fitted model deserves: "provisional" once there is
   * enough paired data to fit something useful, "confirmed" once the full
   * evidence bar is cleared.
   */
  tier: "none" | "provisional" | "confirmed";
  /** Plain-language reading of where the surveillance has got to. */
  summary: string;
  readiness: {
    points: { have: number; need: number };
    sessions: { have: number; need: number };
    /** Thresholds for the early, clearly-labelled provisional model. */
    provisional: { points: number; sessions: number; met: boolean };
    /** Bias confidence interval excludes zero. */
    biasSignificant: boolean;
  };
}

/** Evidence needed before the app will touch the index. */
export const MIN_POINTS = 30;
export const MIN_SESSIONS = 3;
/**
 * Waiting for 30 readings across 3 cases leaves a clinician with no COEBIS
 * number at all for weeks. Once there are a handful of paired readings from
 * more than one case, COEBIS is fitted and shown — heavily shrunk toward the
 * published index and labelled provisional until the full bar is cleared.
 */
export const PROVISIONAL_MIN_POINTS = 8;
export const PROVISIONAL_MIN_SESSIONS = 2;
/** Bias smaller than this is not worth correcting for. */
export const MIN_MEANINGFUL_BIAS = 3;
/** A fit must remove at least this much mean absolute error to be applied. */
export const MIN_MAE_GAIN = 1;
/** Guard rails on the fitted map; anything outside is treated as a bad fit. */
export const GAIN_LIMITS: [number, number] = [0.6, 1.6];
export const MAX_OFFSET = 30;
/** Shrinkage sample size: at n points the fit carries n/(n+K) of its weight. */
const SHRINK_K = 40;
/**
 * Weight floor for a reading taken during poor signal. A reading logged while
 * the headband was noisy is still evidence — it is just weaker evidence than
 * one taken on a clean trace, so it is down-weighted rather than discarded.
 */
export const MIN_POINT_WEIGHT = 0.25;

/**
 * How much a paired reading counts toward the fit: full weight on a clean,
 * reliable epoch, tapering toward the floor as signal quality falls or the
 * epoch was flagged unreliable at the time.
 */
export function pointWeight(p: { reliable?: boolean; sqi?: number | null }): number {
  const sqi = typeof p.sqi === "number" && Number.isFinite(p.sqi) ? p.sqi : null;
  // SQI is a percentage; 100 % earns full weight, 50 % or below earns the floor.
  const quality = sqi == null ? 0.85 : Math.min(1, Math.max(0, (sqi - 50) / 50));
  const reliability = p.reliable === false ? 0.5 : 1;
  // A reading taken mid-transition is compared against a monitor number that
  // reflects the recent past, so it is evidence about the lag as much as about
  // the calibration. Keep it, but at half authority.
  const stability =
    (p as { stability?: PairStability }).stability === "transitional" ? TRANSITIONAL_WEIGHT : 1;
  return Math.max(MIN_POINT_WEIGHT, Math.min(1, quality * reliability * stability));
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

function sd(v: number[]): number | null {
  if (v.length < 2) return null;
  const m = mean(v)!;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

const round = (v: number | null, dp = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

/** Apply an alignment to a raw index, clamped to the 0–100 scale. */
export function alignIndex(
  index: number,
  fit: { gain: number; offset: number; knots?: BisKnot[] },
): number {
  const affine = fit.gain * index + fit.offset;
  const v = affine + knotCorrection(affine, fit.knots);
  return Math.min(100, Math.max(0, v));
}

/** Positions on the aligned scale where COEBIS learns a residual correction. */
export const KNOT_POSITIONS = [20, 30, 40, 50, 60, 70, 80];
/** Half-width of the neighbourhood pooled for each knot. */
const KNOT_WINDOW = 10;
/** Shrinkage sample size for the residual corrections. */
const KNOT_SHRINK_K = 15;
/** No knot may move the index by more than this. */
export const MAX_KNOT_CORRECTION = 8;

/**
 * Fit the residual corrections that turn the straight-line alignment into the
 * COEBIS model: for each knot, the shrunk mean residual (BIS − aligned index)
 * of nearby points. With few points near a knot the correction collapses to
 * zero, so sparse depth ranges are left on the affine map.
 */
export function fitCoebisKnots(
  points: BisDriftPoint[],
  affine: { gain: number; offset: number },
): BisKnot[] {
  const mapped = points.map((p) => ({
    x: affine.gain * p.appIndex + affine.offset,
    r: p.bis - (affine.gain * p.appIndex + affine.offset),
    w: pointWeight(p),
  }));
  const knots: BisKnot[] = [];
  for (const x of KNOT_POSITIONS) {
    const near = mapped.filter((m) => Math.abs(m.x - x) <= KNOT_WINDOW);
    if (near.length < 5) {
      knots.push({ x, dy: 0 });
      continue;
    }
    const wsum = near.reduce((s, v) => s + v.w, 0);
    const m = wsum > 0 ? near.reduce((s, v) => s + v.w * v.r, 0) / wsum : 0;
    // Effective sample size: noisy readings buy less confidence.
    const lambda = wsum / (wsum + KNOT_SHRINK_K);
    const dy = Math.max(-MAX_KNOT_CORRECTION, Math.min(MAX_KNOT_CORRECTION, lambda * m));
    knots.push({ x, dy: Number(dy.toFixed(2)) });
  }
  return knots;
}

/**
 * Ordinary least squares of BIS on the app index, shrunk toward the identity
 * map so that a handful of points cannot produce an aggressive rescaling.
 */
export function fitAlignment(points: BisDriftPoint[]): BisAlignmentFit | null {
  if (points.length < 5) return null;
  const xs = points.map((p) => p.appIndex);
  const ys = points.map((p) => p.bis);
  const ws = points.map((p) => pointWeight(p));
  const wsum = ws.reduce((a, b) => a + b, 0) || 1;
  const mx = xs.reduce((s, x, i) => s + ws[i]! * x, 0) / wsum;
  const my = ys.reduce((s, y, i) => s + ws[i]! * y, 0) / wsum;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += ws[i]! * (xs[i]! - mx) * (ys[i]! - my);
    sxx += ws[i]! * (xs[i]! - mx) ** 2;
  }
  // With no spread in the app index only an offset is identifiable.
  const rawGain = sxx < 1e-6 ? 1 : sxy / sxx;
  const rawOffset = sxx < 1e-6 ? my - mx : my - rawGain * mx;

  const lambda = wsum / (wsum + SHRINK_K);
  const gain = 1 + lambda * (rawGain - 1);
  const offset = lambda * rawOffset + (1 - lambda) * 0;

  const knots = fitCoebisKnots(points, { gain, offset });
  const before = xs.map((x, i) => x - ys[i]!);
  const after = xs.map((x, i) => alignIndex(x, { gain, offset, knots }) - ys[i]!);
  return {
    gain: Number(gain.toFixed(4)),
    offset: Number(offset.toFixed(3)),
    knots,
    n: points.length,
    sessions: new Set(points.map((p) => p.sessionId ?? "unfiled")).size,
    biasBefore: round(mean(before))!,
    biasAfter: round(mean(after))!,
    maeBefore: round(mean(before.map(Math.abs)))!,
    maeAfter: round(mean(after.map(Math.abs)))!,
  };
}

/** True when a fit is safe to put in front of a clinician's index. */
export function fitIsSafe(fit: BisAlignmentFit | null): boolean {
  if (!fit) return false;
  return (
    fit.gain >= GAIN_LIMITS[0] &&
    fit.gain <= GAIN_LIMITS[1] &&
    Math.abs(fit.offset) <= MAX_OFFSET &&
    fit.maeBefore - fit.maeAfter >= MIN_MAE_GAIN
  );
}

/** Pooled surveillance of the open index against the commercial monitor. */
export function analyseBisDrift(
  points: BisDriftPoint[],
  active: { gain: number; offset: number } | null = null,
): BisDriftAnalysis {
  const usable = points.filter(
    (p) => Number.isFinite(p.bis) && Number.isFinite(p.appIndex),
  );
  const diffs = usable.map((p) => p.appIndex - p.bis);
  const bias = mean(diffs);
  const spread = sd(diffs);
  // Readings cluster inside cases, so a naive sd/sqrt(n) interval is too tight
  // and would declare an offset "real" on the strength of one long case.
  const robust = clusterRobustMeanCi(
    usable.map((p) => ({ caseKey: p.sessionId ?? "unfiled", value: p.appIndex - p.bis })),
  );
  const ci: [number, number] | null = robust ? robust.ci : null;
  const sessions = new Set(usable.map((p) => p.sessionId ?? "unfiled")).size;
  const reliable = usable.filter((p) => p.reliable);

  const bands: BisDriftBand[] = BIS_BANDS.map((b) => {
    const inBand = usable.filter((p) => p.bis >= b.low && p.bis < b.high);
    const d = inBand.map((p) => p.appIndex - p.bis);
    return {
      band: b.label,
      n: inBand.length,
      bias: round(mean(d), 1),
      meanAbsolute: round(mean(d.map(Math.abs)), 1),
    };
  });

  const recentPoints = [...usable]
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .slice(-60);
  const recent = {
    n: recentPoints.length,
    bias: round(mean(recentPoints.map((p) => p.appIndex - p.bis)), 1),
  };

  // Prefer the epochs the app itself judged reliable; fall back to everything
  // when there are too few of those to fit on.
  const fitSet = reliable.length >= MIN_POINTS ? reliable : usable;
  const fit = fitAlignment(fitSet);

  const biasSignificant = ci != null && (ci[0] > 0 || ci[1] < 0);
  const enough = usable.length >= MIN_POINTS && sessions >= MIN_SESSIONS;
  const provisionalReady =
    usable.length >= PROVISIONAL_MIN_POINTS && sessions >= PROVISIONAL_MIN_SESSIONS;
  const meaningful = bias != null && Math.abs(bias) >= MIN_MEANINGFUL_BIAS;

  let verdict: DriftVerdict;
  if (!enough) verdict = usable.length ? "watching" : "insufficient";
  else if (!meaningful || !biasSignificant) verdict = "aligned";
  else if (fitIsSafe(fit)) verdict = active ? "adjustment_active" : "adjust";
  else verdict = "watching";
  // Early evidence: fit and show COEBIS, but say plainly that it is provisional.
  if (!enough && provisionalReady && meaningful && biasSignificant && fitIsSafe(fit)) {
    verdict = "provisional";
  }
  const tier: BisDriftAnalysis["tier"] =
    verdict === "adjust" || verdict === "adjustment_active"
      ? "confirmed"
      : verdict === "provisional"
        ? "provisional"
        : "none";

  const direction = bias == null ? "" : bias > 0 ? "lighter" : "deeper";
  const summary =
    verdict === "insufficient"
      ? "No paired BIS readings yet. Log values from the commercial monitor during cases and the app will watch for a systematic offset."
      : verdict === "provisional"
        ? `Provisional COEBIS model from ${usable.length} paired reading${usable.length === 1 ? "" : "s"} across ${sessions} case${sessions === 1 ? "" : "s"}: the open index reads ${Math.abs(bias!).toFixed(1)} points ${direction} than the monitor, and the fitted correction cuts mean absolute error from ${fit!.maeBefore.toFixed(1)} to ${fit!.maeAfter.toFixed(1)} points. Treat the number as indicative until ${MIN_POINTS} readings across ${MIN_SESSIONS} cases confirm it.`
        : verdict === "watching" && !enough
        ? `Watching: ${usable.length} paired reading${usable.length === 1 ? "" : "s"} from ${sessions} case${sessions === 1 ? "" : "s"}${
            bias != null ? `, mean offset ${bias > 0 ? "+" : ""}${bias.toFixed(1)} (${direction} than BIS)` : ""
          }. ${MIN_POINTS} readings across ${MIN_SESSIONS} cases are needed before the index is adjusted.`
        : verdict === "aligned"
          ? `No correction warranted: mean offset ${bias! > 0 ? "+" : ""}${bias!.toFixed(1)} index points over ${usable.length} readings, which is within normal scatter.`
          : verdict === "watching"
            ? `A consistent offset of ${bias! > 0 ? "+" : ""}${bias!.toFixed(1)} points is present, but no correction fitted so far improves agreement enough to be worth applying. Continuing to watch.`
            : `The open index reads ${Math.abs(bias!).toFixed(1)} points ${direction} than the commercial monitor on average across ${usable.length} readings from ${sessions} cases. Correcting with BIS ≈ ${fit!.gain.toFixed(3)} × index ${fit!.offset >= 0 ? "+" : "−"} ${Math.abs(fit!.offset).toFixed(1)} cuts mean absolute error from ${fit!.maeBefore.toFixed(1)} to ${fit!.maeAfter.toFixed(1)} points.`;

  return {
    n: usable.length,
    nReliable: reliable.length,
    sessions,
    bias: round(bias, 2),
    sd: round(spread, 2),
    ci,
    designEffect: robust ? robust.designEffect : null,
    icc: robust ? robust.icc : null,
    nTransitional: usable.filter((p) => p.stability === "transitional").length,
    mae: round(mean(diffs.map(Math.abs)), 2),
    r: usable.length >= 3 ? round(pearson(usable.map((p) => p.appIndex), usable.map((p) => p.bis)), 3) : null,
    bands,
    recent,
    fit,
    verdict,
    tier,
    summary,
    readiness: {
      points: { have: usable.length, need: MIN_POINTS },
      sessions: { have: sessions, need: MIN_SESSIONS },
      provisional: {
        points: PROVISIONAL_MIN_POINTS,
        sessions: PROVISIONAL_MIN_SESSIONS,
        met: provisionalReady,
      },
      biasSignificant,
    },
  };
}
