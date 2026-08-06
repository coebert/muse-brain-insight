/**
 * Explicit "no data" segments.
 *
 * When the headband drops out, no epochs are produced for that period. Every
 * consumer that plots epochs by index — or interpolates between the two
 * epochs bracketing a hole — will otherwise draw straight through the missing
 * time, which reads as real, continuous EEG. These helpers turn the absence
 * of epochs into first-class gap segments so trends break, the DSA shows
 * backdrop, and analyses can exclude the period rather than interpolate it.
 */

/** Nominal spacing between epochs, in seconds. */
export const EPOCH_CADENCE_SECONDS = 1;

/**
 * Missing time is only called a gap once it exceeds this many cadences, so
 * ordinary jitter in epoch timing is not reported as lost data.
 */
export const GAP_CADENCE_FACTOR = 2.5;

export interface DataGap {
  /** Time of the last epoch before the gap, in seconds since case start. */
  startT: number;
  /** Time of the first epoch after the gap (equal to the case end if open). */
  endT: number;
  /** Length of the missing stretch, in seconds. */
  seconds: number;
}

export function gapThresholdSeconds(cadence = EPOCH_CADENCE_SECONDS): number {
  return cadence * GAP_CADENCE_FACTOR;
}

/** Gap segments between consecutive epoch timestamps (ascending). */
export function detectGaps(times: number[], cadence = EPOCH_CADENCE_SECONDS): DataGap[] {
  const threshold = gapThresholdSeconds(cadence);
  const gaps: DataGap[] = [];
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1]!;
    const b = times[i]!;
    const delta = b - a;
    if (delta > threshold) gaps.push({ startT: a, endT: b, seconds: delta });
  }
  return gaps;
}

/** Total seconds of missing EEG across all gaps. */
export function totalGapSeconds(gaps: DataGap[]): number {
  return gaps.reduce((sum, g) => sum + g.seconds, 0);
}

/** True when `t` falls inside a gap (exclusive of the bracketing epochs). */
export function isInGap(gaps: DataGap[], t: number): boolean {
  return gaps.some((g) => t > g.startT && t < g.endT);
}

/**
 * Whether the stretch between two epoch times is a gap rather than a normal
 * epoch-to-epoch step. Used by time-interpolating renderers, which must not
 * blend across missing data.
 */
export function spansGap(tA: number, tB: number, cadence = EPOCH_CADENCE_SECONDS): boolean {
  return tB - tA > gapThresholdSeconds(cadence);
}

/**
 * Expands epochs onto a regular one-slot-per-cadence timeline, inserting
 * `null` for every cadence with no epoch. Index i is `firstT + i * cadence`.
 */
export function alignSeries<T, V>(
  items: T[],
  time: (item: T) => number,
  value: (item: T) => V | null,
  cadence = EPOCH_CADENCE_SECONDS,
): (V | null)[] {
  if (items.length === 0) return [];
  const first = time(items[0]!);
  const last = time(items[items.length - 1]!);
  const slots = Math.max(1, Math.round((last - first) / cadence) + 1);
  // Guard against a pathological timeline blowing up memory.
  if (slots > 100_000) return items.map((item) => value(item));
  const out: (V | null)[] = new Array(slots).fill(null);
  for (const item of items) {
    const idx = Math.round((time(item) - first) / cadence);
    if (idx >= 0 && idx < slots) out[idx] = value(item);
  }
  return out;
}

/** Runs of consecutive `null` slots in an aligned series, as [start, end] indices. */
export function nullRuns(values: readonly (unknown | null)[]): [number, number][] {
  const runs: [number, number][] = [];
  let start: number | null = null;
  values.forEach((v, i) => {
    const missing = v == null;
    if (missing && start == null) start = i;
    if (!missing && start != null) {
      runs.push([start, i - 1]);
      start = null;
    }
  });
  if (start != null) runs.push([start, values.length - 1]);
  return runs;
}

/**
 * Inserts an all-null marker row into a time-ordered metric series wherever a
 * gap occurs, so charts that plot by time break the line instead of joining
 * the two sides of the hole.
 */
export function withGapRows<T extends { t: number }>(
  rows: T[],
  blank: (t: number) => T,
  cadence = EPOCH_CADENCE_SECONDS,
): T[] {
  if (rows.length < 2) return rows;
  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const prev = rows[i - 1];
    if (prev && spansGap(prev.t, row.t, cadence)) {
      out.push(blank(prev.t + cadence / 2));
      out.push(blank(row.t - cadence / 2));
    }
    out.push(row);
  }
  return out;
}