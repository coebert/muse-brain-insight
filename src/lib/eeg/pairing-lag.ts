/**
 * Time alignment between the app's index and a commercial monitor reading.
 *
 * A commercial BIS number is a smoothed statistic: the displayed value reflects
 * EEG from roughly the last 15–30 s, not the instant it is read. A clinician
 * who transcribes "BIS 44 now" is therefore pairing the app's *current* index
 * with the monitor's view of the *recent past*. While depth is steady this does
 * not matter. During induction, a bolus or emergence it matters a great deal:
 * the pair carries a lag error that a naive fit absorbs as if it were a real
 * calibration offset.
 *
 * Two defences live here:
 *  - `estimateMonitorLagSeconds` finds the shift that minimises mean absolute
 *    error (not the shift that maximises correlation, which can leave a large
 *    fixed offset untouched).
 *  - `classifyStability` labels each reading from the rate of change of the
 *    index around it, so transitional readings can be down-weighted instead of
 *    silently biasing the model.
 */

/** Published smoothing delay of a bedside depth monitor, seconds. */
export const DEFAULT_MONITOR_LAG_SECONDS = 20;
/** Shifts searched when the lag is estimated from data. */
export const LAG_SEARCH_SECONDS = [0, 5, 10, 15, 20, 25, 30, 35, 40];

export type PairStability = "stable" | "transitional" | "unknown";

/** Index change per minute at or below which a reading counts as stable. */
export const STABLE_SLOPE_PER_MIN = 4;
/** Weight multiplier applied to a reading taken while depth was moving. */
export const TRANSITIONAL_WEIGHT = 0.5;

export interface IndexSample {
  /** Case-clock seconds. */
  t: number;
  value: number;
}

/** Value of a case-clock index series at time `t`, linearly interpolated. */
export function sampleAt(series: IndexSample[], t: number): number | null {
  if (!series.length) return null;
  const sorted = series;
  if (t <= sorted[0]!.t) return sorted[0]!.value;
  const last = sorted[sorted.length - 1]!;
  if (t >= last.t) return last.value;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (t <= b.t) {
      const span = b.t - a.t;
      if (span <= 0) return b.value;
      const f = (t - a.t) / span;
      return a.value + f * (b.value - a.value);
    }
  }
  return last.value;
}

/**
 * Slope of the index around `t`, in index points per minute. Uses the widest
 * window available inside +/-`halfWindow` seconds so a single noisy epoch does
 * not decide whether a reading was taken during a transition.
 */
export function slopePerMinute(series: IndexSample[], t: number, halfWindow = 30): number | null {
  const before = sampleAt(series, t - halfWindow);
  const after = sampleAt(series, t + halfWindow);
  if (before == null || after == null) return null;
  const span = (2 * halfWindow) / 60;
  if (span <= 0) return null;
  return (after - before) / span;
}

/** Stable / transitional label for one paired reading. */
export function classifyStability(slopePerMin: number | null): PairStability {
  if (slopePerMin == null || !Number.isFinite(slopePerMin)) return "unknown";
  return Math.abs(slopePerMin) <= STABLE_SLOPE_PER_MIN ? "stable" : "transitional";
}

export interface LagCandidate {
  lagSeconds: number;
  mae: number;
  bias: number;
  n: number;
}

export interface MonitorLagEstimate {
  /** Best shift found, seconds the app index is moved back before pairing. */
  lagSeconds: number;
  /** Whether the data actually supported the estimate. */
  estimated: boolean;
  candidates: LagCandidate[];
  /** MAE at zero lag minus MAE at the chosen lag. */
  maeGain: number | null;
  summary: string;
}

export interface LagPairInput {
  /** Case-clock second the clinician transcribed the monitor value. */
  at: number;
  bis: number;
  /** The app index series for that case, oldest first. */
  series: IndexSample[];
}

/**
 * Estimate the monitor's effective lag by trying each candidate shift and
 * keeping the one with the lowest mean absolute error against the transcribed
 * values. Falls back to the published default when there is too little data or
 * no shift meaningfully beats zero.
 */
export function estimateMonitorLagSeconds(
  pairs: LagPairInput[],
  { minPairs = 12, minGain = 0.3 } = {},
): MonitorLagEstimate {
  const candidates: LagCandidate[] = [];
  for (const lag of LAG_SEARCH_SECONDS) {
    const diffs: number[] = [];
    for (const p of pairs) {
      const v = sampleAt(p.series, p.at - lag);
      if (v == null || !Number.isFinite(p.bis)) continue;
      diffs.push(v - p.bis);
    }
    if (!diffs.length) continue;
    const mae = diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length;
    const bias = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    candidates.push({
      lagSeconds: lag,
      mae: Number(mae.toFixed(3)),
      bias: Number(bias.toFixed(3)),
      n: diffs.length,
    });
  }
  const zero = candidates.find((c) => c.lagSeconds === 0) ?? null;
  const usable = candidates.filter((c) => c.n >= minPairs);
  if (!zero || usable.length < 2) {
    return {
      lagSeconds: DEFAULT_MONITOR_LAG_SECONDS,
      estimated: false,
      candidates,
      maeGain: null,
      summary: `Not enough paired readings with a recorded trend to estimate the monitor's smoothing delay; assuming the published ${DEFAULT_MONITOR_LAG_SECONDS} s.`,
    };
  }
  const best = usable.reduce((a, b) => (b.mae < a.mae ? b : a));
  const gain = Number((zero.mae - best.mae).toFixed(3));
  if (best.lagSeconds === 0 || gain < minGain) {
    return {
      lagSeconds: 0,
      estimated: true,
      candidates,
      maeGain: gain,
      summary:
        "Shifting the app index back does not improve agreement, so readings are paired as transcribed.",
    };
  }
  return {
    lagSeconds: best.lagSeconds,
    estimated: true,
    candidates,
    maeGain: gain,
    summary: `Pairing the monitor value against the app index from ${best.lagSeconds} s earlier cuts mean absolute error by ${gain.toFixed(2)} points — the monitor's displayed number lags the EEG by about that much.`,
  };
}

/**
 * Re-pair one reading using a known lag: the monitor value is compared with the
 * app index as it was `lagSeconds` before the reading was transcribed.
 */
export function laggedAppIndex(
  series: IndexSample[],
  at: number,
  lagSeconds: number,
  fallback: number,
): number {
  const v = sampleAt(series, at - lagSeconds);
  return v == null ? fallback : v;
}
