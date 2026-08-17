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

/**
 * Cluster-robust confidence interval for a mean difference.
 *
 * Readings from one case are correlated, so `sd/sqrt(n)` treats a handful of
 * patients as if they were dozens of independent observations and reports an
 * interval that is too tight. This inflates the standard error by the design
 * effect `1 + (m̄ − 1)·ICC`, where ICC is the share of variance explained by
 * the case and m̄ is the average readings per case — the standard correction
 * for clustered data, and the honest denominator for "is this offset real".
 */
export function clusterRobustMeanCi(
  values: { caseKey: string; value: number }[],
  level = 0.95,
): { mean: number; se: number; ci: [number, number]; designEffect: number; icc: number } | null {
  const usable = values.filter((v) => Number.isFinite(v.value));
  const n = usable.length;
  if (n < 2) return null;
  const mean = usable.reduce((s, v) => s + v.value, 0) / n;
  const variance = usable.reduce((s, v) => s + (v.value - mean) ** 2, 0) / (n - 1);
  if (variance <= 0) {
    return { mean, se: 0, ci: [mean, mean], designEffect: 1, icc: 0 };
  }

  const byCase = new Map<string, number[]>();
  for (const v of usable) byCase.set(v.caseKey, [...(byCase.get(v.caseKey) ?? []), v.value]);
  const groups = [...byCase.values()];
  const k = groups.length;

  let icc = 0;
  if (k > 1 && k < n) {
    let withinSs = 0;
    let withinDf = 0;
    let betweenSs = 0;
    for (const g of groups) {
      const gm = g.reduce((a, b) => a + b, 0) / g.length;
      betweenSs += g.length * (gm - mean) ** 2;
      if (g.length > 1) {
        withinSs += g.reduce((s, v) => s + (v - gm) ** 2, 0);
        withinDf += g.length - 1;
      }
    }
    const msWithin = withinDf > 0 ? withinSs / withinDf : 0;
    const msBetween = betweenSs / (k - 1);
    const mBar = n / k;
    const between = mBar > 0 ? Math.max(0, (msBetween - msWithin) / mBar) : 0;
    const total = between + msWithin;
    icc = total > 0 ? Math.min(1, between / total) : 0;
  }
  const mBar = n / Math.max(1, k);
  const designEffect = Math.max(1, 1 + (mBar - 1) * icc);
  const se = Math.sqrt((variance / n) * designEffect);
  const z = level >= 0.99 ? 2.576 : 1.96;
  return {
    mean: Number(mean.toFixed(3)),
    se: Number(se.toFixed(3)),
    ci: [Number((mean - z * se).toFixed(2)), Number((mean + z * se).toFixed(2))],
    designEffect: Number(designEffect.toFixed(2)),
    icc: Number(icc.toFixed(3)),
  };
}

/** "3.1 (95% CI 2.4–4.0)" */
export function withInterval(value: number | null, ci: Interval | null, dp = 1): string {
  if (value == null) return "—";
  const v = value.toFixed(dp);
  return ci ? `${v} (95% CI ${ci.lo.toFixed(dp)}–${ci.hi.toFixed(dp)})` : v;
}
