/**
 * Phase 6 — honest uncertainty.
 *
 * A mean absolute error quoted without an interval invites over-reading: with
 * 30 readings from three patients, an MAE of 3.1 and one of 4.0 are the same
 * number. Paired readings are also clustered — many come from the same case —
 * so a naive bootstrap that resamples readings understates the interval. These
 * helpers resample whole cases.
 */

/** Deterministic generator, so a report does not change between renders. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface Interval {
  lo: number;
  hi: number;
}

export interface ClusteredPair {
  /** Case the reading came from; readings sharing a key move together. */
  caseKey: string;
  predicted: number;
  bis: number;
}

/**
 * Percentile bootstrap interval for a statistic of clustered pairs. Returns
 * null when there is too little data for an interval to mean anything.
 */
export function clusterBootstrapCi(
  pairs: ClusteredPair[],
  statistic: (sample: ClusteredPair[]) => number | null,
  { iterations = 400, level = 0.95, seed = 20260816 } = {},
): Interval | null {
  const keys = [...new Set(pairs.map((p) => p.caseKey))];
  if (pairs.length < 8 || keys.length < 3) return null;
  const byKey = new Map<string, ClusteredPair[]>();
  for (const p of pairs) byKey.set(p.caseKey, [...(byKey.get(p.caseKey) ?? []), p]);

  const rand = lcg(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample: ClusteredPair[] = [];
    for (let k = 0; k < keys.length; k++) {
      const key = keys[Math.floor(rand() * keys.length)]!;
      sample.push(...(byKey.get(key) ?? []));
    }
    const s = statistic(sample);
    if (s != null && Number.isFinite(s)) stats.push(s);
  }
  if (stats.length < iterations / 4) return null;
  stats.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  const at = (q: number) => stats[Math.min(stats.length - 1, Math.max(0, Math.round(q * (stats.length - 1))))]!;
  return { lo: Number(at(alpha).toFixed(2)), hi: Number(at(1 - alpha).toFixed(2)) };
}

export const maeStatistic = (sample: ClusteredPair[]): number | null =>
  sample.length ? sample.reduce((s, p) => s + Math.abs(p.predicted - p.bis), 0) / sample.length : null;

export const biasStatistic = (sample: ClusteredPair[]): number | null =>
  sample.length ? sample.reduce((s, p) => s + (p.predicted - p.bis), 0) / sample.length : null;

/** "3.1 (95% CI 2.4–4.0)" */
export function withInterval(value: number | null, ci: Interval | null, dp = 1): string {
  if (value == null) return "—";
  const v = value.toFixed(dp);
  return ci ? `${v} (95% CI ${ci.lo.toFixed(dp)}–${ci.hi.toFixed(dp)})` : v;
}
