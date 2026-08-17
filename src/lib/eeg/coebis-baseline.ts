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

export interface CoebisBaseline {
  /** Median of the first `BASELINE_SAMPLES` usable values, or null while collecting. */
  value: number | null;
  /** How many usable values have been seen so far. */
  samples: number;
  /** Latest usable COEBIS value in the series. */
  latest: number | null;
  /** latest − baseline, or null when either side is missing. */
  delta: number | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/** Baseline and current drift for a COEBIS series (oldest first, gaps as null). */
export function coebisBaseline(series: (number | null)[]): CoebisBaseline {
  const usable = series.filter((v): v is number => v != null && Number.isFinite(v));
  const latest = usable.length > 0 ? (usable[usable.length - 1] ?? null) : null;
  if (usable.length < BASELINE_SAMPLES) {
    return { value: null, samples: usable.length, latest, delta: null };
  }
  const value = median(usable.slice(0, BASELINE_SAMPLES));
  return {
    value,
    samples: usable.length,
    latest,
    delta: latest != null ? latest - value : null,
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
