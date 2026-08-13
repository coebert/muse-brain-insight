/**
 * Alignment of the headband's spectral edge frequency (SEF95) against SEF
 * values transcribed from a commercial BIS monitor.
 *
 * The Muse 2's dry frontal electrodes, its reference montage and its bandwidth
 * all shift the measured edge frequency relative to a clinical monitor, and
 * the shift is systematic rather than random. Pooling every paired SEF reading
 * across cases lets the app fit a conservative straight-line map
 * (monitor SEF ≈ gain × app SEF + offset) and display the corrected value, so
 * the bedside number is on the same scale the clinician is used to.
 *
 * As with COEBIS the fit is shrunk toward the identity, capped, and only used
 * when it measurably improves agreement.
 */

/** One pooled paired SEF reading, from any case. */
export interface SefDriftPoint {
  /** Case-clock seconds within its own case. */
  at: number;
  /** SEF in Hz from the commercial monitor. */
  monitorSef: number;
  /** Raw (uncorrected) SEF95 in Hz from the headband. */
  appSef: number;
  sessionId: string | null;
  reliable: boolean;
  recordedAt: string;
}

/** monitorSef ≈ gain × appSef + offset. */
export interface SefAlignmentFit {
  gain: number;
  offset: number;
  n: number;
  sessions: number;
  biasBefore: number;
  biasAfter: number;
  maeBefore: number;
  maeAfter: number;
}

export type SefVerdict = "insufficient" | "watching" | "provisional" | "aligned" | "adjusting";

export interface SefDriftAnalysis {
  n: number;
  sessions: number;
  /** Mean (app SEF − monitor SEF) in Hz; positive = the app reads faster. */
  bias: number | null;
  sd: number | null;
  ci: [number, number] | null;
  mae: number | null;
  fit: SefAlignmentFit | null;
  verdict: SefVerdict;
  summary: string;
  readiness: {
    points: { have: number; need: number };
    sessions: { have: number; need: number };
    provisional: { points: number; sessions: number; met: boolean };
    biasSignificant: boolean;
  };
}

/** Full evidence bar before the correction is treated as settled. */
export const SEF_MIN_POINTS = 30;
export const SEF_MIN_SESSIONS = 3;
/** Early evidence: enough to correct, but the model stays labelled provisional. */
export const SEF_PROVISIONAL_MIN_POINTS = 8;
export const SEF_PROVISIONAL_MIN_SESSIONS = 2;
/** Below this the offset is inside ordinary scatter for a frontal montage. */
export const SEF_MIN_MEANINGFUL_BIAS = 0.5;
/** Shrinkage: a small sample only moves the map part of the way. */
const SHRINK_K = 20;
const GAIN_LIMITS: [number, number] = [0.6, 1.6];
const MAX_OFFSET = 8;
/** The fit must cut mean absolute error by at least this much (Hz). */
const MIN_MAE_GAIN = 0.2;
/** Physiological display range for a corrected edge frequency. */
export const SEF_RANGE: [number, number] = [0.5, 30];

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function sd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

const round = (v: number | null, dp = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Least-squares map of app SEF onto monitor SEF, shrunk toward the identity. */
export function fitSefAlignment(points: SefDriftPoint[]): SefAlignmentFit | null {
  if (points.length < 5) return null;
  const xs = points.map((p) => p.appSef);
  const ys = points.map((p) => p.monitorSef);
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  // With no spread in the app SEF only an offset is identifiable.
  const rawGain = sxx < 1e-6 ? 1 : sxy / sxx;
  const rawOffset = sxx < 1e-6 ? my - mx : my - rawGain * mx;

  const lambda = points.length / (points.length + SHRINK_K);
  const gain = 1 + lambda * (rawGain - 1);
  const offset = lambda * rawOffset;

  const before = xs.map((x, i) => x - ys[i]!);
  const after = xs.map((x, i) => applySefAlignment(x, { gain, offset }) - ys[i]!);
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

/** A fit is only used when it is physiologically sane and actually helps. */
export function sefFitIsSafe(fit: SefAlignmentFit | null): boolean {
  if (!fit) return false;
  return (
    fit.gain >= GAIN_LIMITS[0] &&
    fit.gain <= GAIN_LIMITS[1] &&
    Math.abs(fit.offset) <= MAX_OFFSET &&
    fit.maeBefore - fit.maeAfter >= MIN_MAE_GAIN
  );
}

/** Pooled surveillance of the headband SEF against the commercial monitor. */
export function analyseSefDrift(
  points: SefDriftPoint[],
  active: { gain: number; offset: number } | null = null,
): SefDriftAnalysis {
  const usable = points.filter(
    (p) => Number.isFinite(p.monitorSef) && Number.isFinite(p.appSef) && p.appSef > 0,
  );
  const diffs = usable.map((p) => p.appSef - p.monitorSef);
  const bias = mean(diffs);
  const spread = sd(diffs);
  const se = spread != null && usable.length > 1 ? spread / Math.sqrt(usable.length) : null;
  const ci: [number, number] | null =
    bias != null && se != null ? [round(bias - 1.96 * se)!, round(bias + 1.96 * se)!] : null;
  const sessions = new Set(usable.map((p) => p.sessionId ?? "unfiled")).size;
  const reliable = usable.filter((p) => p.reliable);
  const fitSet = reliable.length >= SEF_PROVISIONAL_MIN_POINTS ? reliable : usable;
  const fit = fitSefAlignment(fitSet);

  const biasSignificant = ci != null && (ci[0] > 0 || ci[1] < 0);
  const enough = usable.length >= SEF_MIN_POINTS && sessions >= SEF_MIN_SESSIONS;
  const provisionalReady =
    usable.length >= SEF_PROVISIONAL_MIN_POINTS && sessions >= SEF_PROVISIONAL_MIN_SESSIONS;
  const meaningful = bias != null && Math.abs(bias) >= SEF_MIN_MEANINGFUL_BIAS;
  const safe = sefFitIsSafe(fit);

  let verdict: SefVerdict;
  if (!usable.length) verdict = "insufficient";
  else if (!provisionalReady) verdict = "watching";
  else if (!meaningful || !biasSignificant || !safe) verdict = "aligned";
  else if (enough) verdict = "adjusting";
  else verdict = "provisional";

  const direction = bias == null ? "" : bias > 0 ? "faster" : "slower";
  const hz = (v: number) => `${Math.abs(v).toFixed(1)} Hz`;
  const summary =
    verdict === "insufficient"
      ? "No paired SEF readings yet. Enter the monitor's SEF alongside its BIS during cases and the app will learn the offset."
      : verdict === "watching"
        ? `Watching: ${usable.length} paired SEF reading${usable.length === 1 ? "" : "s"} from ${sessions} case${
            sessions === 1 ? "" : "s"
          }${bias != null ? `, mean offset ${bias > 0 ? "+" : "−"}${hz(bias)} (${direction} than the monitor)` : ""}. ${SEF_PROVISIONAL_MIN_POINTS} readings across ${SEF_PROVISIONAL_MIN_SESSIONS} cases are needed before SEF is corrected.`
        : verdict === "aligned"
          ? `No correction warranted: the headband SEF sits ${bias == null ? "close to" : `${bias > 0 ? "+" : "−"}${hz(bias)} from`} the monitor across ${usable.length} readings, within ordinary scatter for a frontal montage.`
          : `${verdict === "provisional" ? "Provisional correction" : "Correction active"}: the headband reads ${hz(bias!)} ${direction} than the monitor across ${usable.length} readings from ${sessions} case${
              sessions === 1 ? "" : "s"
            }. Displayed SEF ≈ ${fit!.gain.toFixed(3)} × raw ${fit!.offset >= 0 ? "+" : "−"} ${Math.abs(fit!.offset).toFixed(2)} Hz, cutting mean absolute error from ${fit!.maeBefore.toFixed(2)} to ${fit!.maeAfter.toFixed(2)} Hz.${
              verdict === "provisional"
                ? ` Indicative until ${SEF_MIN_POINTS} readings across ${SEF_MIN_SESSIONS} cases confirm it.`
                : ""
            }`;

  return {
    n: usable.length,
    sessions,
    bias: round(bias),
    sd: round(spread),
    ci,
    mae: round(mean(diffs.map(Math.abs))),
    fit,
    verdict: active != null && verdict === "aligned" && safe ? "adjusting" : verdict,
    summary,
    readiness: {
      points: { have: usable.length, need: SEF_MIN_POINTS },
      sessions: { have: sessions, need: SEF_MIN_SESSIONS },
      provisional: {
        points: SEF_PROVISIONAL_MIN_POINTS,
        sessions: SEF_PROVISIONAL_MIN_SESSIONS,
        met: provisionalReady,
      },
      biasSignificant,
    },
  };
}

/** The fitted map the app is currently displaying SEF through. */
export interface SefAlignment {
  gain: number;
  offset: number;
  /** Paired readings the map was fitted on. */
  n: number;
  sessions: number;
  fittedAt: string;
  id?: string;
  /** Fitted on early data — shown, but always labelled provisional. */
  provisional?: boolean;
  biasAfter?: number | null;
  maeAfter?: number | null;
}

let activeSefAlignment: SefAlignment | null = null;

export function getActiveSefAlignment(): SefAlignment | null {
  return activeSefAlignment;
}

export function setActiveSefAlignment(alignment: SefAlignment | null) {
  activeSefAlignment = alignment;
}

/**
 * Map a raw headband SEF onto the commercial scale. With no fitted model the
 * raw value is returned unchanged.
 */
export function applySefAlignment(
  rawHz: number,
  alignment: { gain: number; offset: number } | null = activeSefAlignment,
): number {
  if (!alignment || !Number.isFinite(rawHz)) return rawHz;
  return clamp(alignment.gain * rawHz + alignment.offset, SEF_RANGE[0], SEF_RANGE[1]);
}