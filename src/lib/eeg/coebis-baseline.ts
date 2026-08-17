/**
 * Session baseline for COEBIS.
 *
 * The bedside tile shows "where COEBIS is now"; clinicians also need to see how
 * far it has moved from where this patient started. The baseline is the median
 * of the first stable run of COEBIS values in the case, which keeps a single
 * artefactual epoch from anchoring the whole session.
 */

/** Values required before a baseline is considered established. */
export const BASELINE_SAMPLES = 30;
/**
 * A baseline anchors the whole case, and the start of a case — positioning,
 * induction, electrode settling — is exactly when the trace is worst. Values
 * the app judged unreliable are skipped rather than averaged in.
 */
export interface BaselineOptions {
  /** Per-sample reliability flags, same order as the series. */
  reliable?: (boolean | null | undefined)[];
}

export interface CoebisBaseline {
  /** Median of the first `BASELINE_SAMPLES` usable values, or null while collecting. */
  value: number | null;
  /** How many usable values have been seen so far. */
  samples: number;
  /** Latest usable COEBIS value in the series. */
  latest: number | null;
  /** latest − baseline, or null when either side is missing. */
  delta: number | null;
  /** True when the baseline was built from reliability-gated values only. */
  qualityGated: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/** Baseline and current drift for a COEBIS series (oldest first, gaps as null). */
export function coebisBaseline(
  series: (number | null)[],
  options: BaselineOptions = {},
): CoebisBaseline {
  const flags = options.reliable;
  const all = series
    .map((v, i) => ({ v, reliable: flags ? flags[i] !== false : true }))
    .filter((e): e is { v: number; reliable: boolean } => e.v != null && Number.isFinite(e.v));
  const gated = flags ? all.filter((e) => e.reliable) : all;
  // Fall back to every value only when reliability gating would leave the case
  // without a baseline at all.
  const qualityGated = gated.length >= BASELINE_SAMPLES;
  const source = qualityGated ? gated : all;
  const usable = source.map((e) => e.v);
  const latest = usable.length > 0 ? (usable[usable.length - 1] ?? null) : null;
  if (usable.length < BASELINE_SAMPLES) {
    return { value: null, samples: usable.length, latest, delta: null, qualityGated };
  }
  const value = median(usable.slice(0, BASELINE_SAMPLES));
  return {
    value,
    samples: usable.length,
    latest,
    delta: latest != null ? latest - value : null,
    qualityGated,
  };
}

/** Per-point drift from baseline, preserving nulls so gaps stay breaks. */
export function coebisDriftSeries(
  series: (number | null)[],
  baseline: number | null,
): (number | null)[] {
  if (baseline == null) return series.map(() => null);
  return series.map((v) => (v == null ? null : v - baseline));
}
