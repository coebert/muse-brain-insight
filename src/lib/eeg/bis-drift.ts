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
  mae: number | null;
  r: number | null;
  bands: BisDriftBand[];
  /** Bias over the most recent 60 points, to spot a drift that is changing. */
  recent: { n: number; bias: number | null };
  fit: BisAlignmentFit | null;
  verdict: DriftVerdict;
  /** Plain-language reading of where the surveillance has got to. */
  summary: string;
  readiness: {
    points: { have: number; need: number };
    sessions: { have: number; need: number };
    /** Bias confidence interval excludes zero. */
    biasSignificant: boolean;
  };
}

/** Evidence needed before the app will touch the index. */
export const MIN_POINTS = 30;
export const MIN_SESSIONS = 3;
/** Bias smaller than this is not worth correcting for. */
export const MIN_MEANINGFUL_BIAS = 3;
/** A fit must remove at least this much mean absolute error to be applied. */
export const MIN_MAE_GAIN = 1;
/** Guard rails on the fitted map; anything outside is treated as a bad fit. */
export const GAIN_LIMITS: [number, number] = [0.6, 1.6];
export const MAX_OFFSET = 30;
/** Shrinkage sample size: at n points the fit carries n/(n+K) of its weight. */
const SHRINK_K = 40;

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

function sd(v: number[]): number | null {
  if (v.length < 2) return null;
  const m = mean(v)!;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

const round = (v: number | null, dp = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

/** Apply an alignment to a raw index, clamped to the 0–100 scale. */
export function alignIndex(index: number, fit: { gain: number; offset: number }): number {
  const v = fit.gain * index + fit.offset;
  return Math.min(100, Math.max(0, v));
}

/**
 * Ordinary least squares of BIS on the app index, shrunk toward the identity
 * map so that a handful of points cannot produce an aggressive rescaling.
 */
export function fitAlignment(points: BisDriftPoint[]): BisAlignmentFit | null {
  if (points.length < 5) return null;
  const xs = points.map((p) => p.appIndex);
  const ys = points.map((p) => p.bis);
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  // With no spread in the app index only an offset is identifiable.
  const rawGain = sxx < 1e-6 ? 1 : sxy / sxx;
  const rawOffset = sxx < 1e-6 ? my - mx : my - rawGain * mx;

  const lambda = points.length / (points.length + SHRINK_K);
  const gain = 1 + lambda * (rawGain - 1);
  const offset = lambda * rawOffset + (1 - lambda) * 0;

  const before = xs.map((x, i) => x - ys[i]!);
  const after = xs.map((x, i) => alignIndex(x, { gain, offset }) - ys[i]!);
  return {
    gain: Number(gain.toFixed(4)),
    offset: Number(offset.toFixed(3)),
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
  const se = spread != null && usable.length > 1 ? spread / Math.sqrt(usable.length) : null;
  const ci: [number, number] | null =
    bias != null && se != null ? [round(bias - 1.96 * se)!, round(bias + 1.96 * se)!] : null;
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
  const meaningful = bias != null && Math.abs(bias) >= MIN_MEANINGFUL_BIAS;

  let verdict: DriftVerdict;
  if (!enough) verdict = usable.length ? "watching" : "insufficient";
  else if (!meaningful || !biasSignificant) verdict = "aligned";
  else if (fitIsSafe(fit)) verdict = active ? "adjustment_active" : "adjust";
  else verdict = "watching";

  const direction = bias == null ? "" : bias > 0 ? "lighter" : "deeper";
  const summary =
    verdict === "insufficient"
      ? "No paired BIS readings yet. Log values from the commercial monitor during cases and the app will watch for a systematic offset."
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
    mae: round(mean(diffs.map(Math.abs)), 2),
    r: usable.length >= 3 ? round(pearson(usable.map((p) => p.appIndex), usable.map((p) => p.bis)), 3) : null,
    bands,
    recent,
    fit,
    verdict,
    summary,
    readiness: {
      points: { have: usable.length, need: MIN_POINTS },
      sessions: { have: sessions, need: MIN_SESSIONS },
      biasSignificant,
    },
  };
}
