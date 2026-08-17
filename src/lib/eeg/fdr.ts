/**
 * Multiplicity control for subgroup reporting.
 *
 * COEBIS reports agreement across roughly twenty subgroups — age bands, sex,
 * regimen, frailty, depth band. Testing twenty subgroups at the 5 % level
 * produces about one "weak spot" by chance in every report even when the model
 * is perfectly calibrated everywhere. Benjamini-Hochberg controls the expected
 * share of false discoveries among the findings that are flagged.
 */

export interface FdrInput<T> {
  item: T;
  /** Two-sided p-value for this item. */
  p: number;
}

export interface FdrResult<T> {
  item: T;
  p: number;
  /** BH-adjusted p-value (q-value), monotone in p. */
  q: number;
  /** Survives the false-discovery-rate threshold. */
  significant: boolean;
}

/** Benjamini-Hochberg step-up procedure at false-discovery rate `alpha`. */
export function benjaminiHochberg<T>(inputs: FdrInput<T>[], alpha = 0.05): FdrResult<T>[] {
  const valid = inputs.filter((i) => Number.isFinite(i.p));
  const m = valid.length;
  if (!m) return [];
  const ordered = [...valid]
    .map((v, idx) => ({ ...v, idx }))
    .sort((a, b) => a.p - b.p);

  // Step-up: walk from the largest p downward, carrying the running minimum.
  const q: number[] = new Array(m).fill(1);
  let running = 1;
  for (let i = m - 1; i >= 0; i--) {
    running = Math.min(running, (ordered[i]!.p * m) / (i + 1));
    q[i] = Math.min(1, running);
  }
  return ordered.map((o, i) => ({
    item: o.item,
    p: o.p,
    q: Number(q[i]!.toFixed(4)),
    significant: q[i]! <= alpha,
  }));
}

/** Two-sided normal-approximation p-value for a mean against zero. */
export function pValueForMean(mean: number | null, se: number | null): number {
  if (mean == null || se == null || !Number.isFinite(mean) || !Number.isFinite(se) || se <= 0) {
    return 1;
  }
  const z = Math.abs(mean / se);
  // Abramowitz & Stegun 26.2.17 tail approximation.
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const tail =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, Math.max(0, 2 * tail));
}
