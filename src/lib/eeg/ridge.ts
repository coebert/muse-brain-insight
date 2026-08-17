/**
 * Weighted ridge regression with collinearity diagnostics.
 *
 * COEBIS learned its patient corrections one covariate at a time: fit an age
 * effect on the pooled residual, then a regimen effect on the same residual,
 * then add both. Age, frailty and regimen travel together in real theatre
 * lists — an eighty-nine-year-old frail patient is far more likely to be on a
 * low-dose volatile — so the same underlying difference was counted two or
 * three times. Fitting every level in one penalised regression shares that
 * signal out instead of duplicating it.
 */

export interface RidgeFit {
  /** Unpenalised intercept. */
  intercept: number;
  /** One coefficient per design column. */
  coefficients: number[];
  /** Variance inflation factor per column; > 5 means badly entangled. */
  vif: number[];
  n: number;
}

function solveSpd(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (!n) return [];
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / p;
      if (!f) continue;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]![i]!);
}

/**
 * Ridge fit of `y` on design `x` with observation weights `w`. Each column may
 * carry its own penalty, so a thinly-observed level is shrunk harder than a
 * well-observed one. The intercept is fitted but never penalised.
 */
export function ridgeFit(
  x: number[][],
  y: number[],
  w: number[],
  penalties: number[],
): RidgeFit | null {
  const n = y.length;
  const k = x[0]?.length ?? 0;
  if (!n || !k) return null;
  const dim = k + 1;
  const ata: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const aty: number[] = new Array(dim).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...x[i]!];
    const wi = w[i] ?? 1;
    for (let a = 0; a < dim; a++) {
      if (!row[a]) continue;
      aty[a]! += wi * row[a]! * y[i]!;
      for (let b = 0; b < dim; b++) {
        if (!row[b]) continue;
        ata[a]![b]! += wi * row[a]! * row[b]!;
      }
    }
  }
  for (let a = 1; a < dim; a++) ata[a]![a]! += Math.max(1e-6, penalties[a - 1] ?? 1);
  const solved = solveSpd(ata, aty);
  if (!solved) return null;
  return {
    intercept: solved[0]!,
    coefficients: solved.slice(1),
    vif: varianceInflation(x, w),
    n,
  };
}

/**
 * How much each column's estimate is inflated by its overlap with the others.
 * A column that is nearly a combination of its neighbours cannot be told apart
 * from them, and its "effect" is not to be trusted on its own.
 */
export function varianceInflation(x: number[][], w?: number[]): number[] {
  const k = x[0]?.length ?? 0;
  const n = x.length;
  const out: number[] = new Array(k).fill(1);
  if (n < k + 2) return out;
  for (let target = 0; target < k; target++) {
    const others = Array.from({ length: k }, (_, i) => i).filter((i) => i !== target);
    const design = x.map((row) => others.map((i) => row[i]!));
    const y = x.map((row) => row[target]!);
    const weights = w ?? new Array(n).fill(1);
    const fit = others.length
      ? ridgeCore(design, y, weights, others.map(() => 1e-4))
      : null;
    if (!fit) continue;
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;
    const my = y.reduce((s, v, i) => s + weights[i]! * v, 0) / wsum;
    let ssTot = 0;
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
      const pred =
        fit.intercept + design[i]!.reduce((s, v, j) => s + v * fit.coefficients[j]!, 0);
      ssTot += weights[i]! * (y[i]! - my) ** 2;
      ssRes += weights[i]! * (y[i]! - pred) ** 2;
    }
    if (ssTot <= 1e-9) continue;
    const r2 = Math.max(0, Math.min(0.999, 1 - ssRes / ssTot));
    out[target] = Number((1 / (1 - r2)).toFixed(2));
  }
  return out;
}

/** Ridge solve without the recursive VIF pass. */
function ridgeCore(
  x: number[][],
  y: number[],
  w: number[],
  penalties: number[],
): { intercept: number; coefficients: number[] } | null {
  const n = y.length;
  const k = x[0]?.length ?? 0;
  if (!n || !k) return null;
  const dim = k + 1;
  const ata: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const aty: number[] = new Array(dim).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...x[i]!];
    const wi = w[i] ?? 1;
    for (let a = 0; a < dim; a++) {
      aty[a]! += wi * row[a]! * y[i]!;
      for (let b = 0; b < dim; b++) ata[a]![b]! += wi * row[a]! * row[b]!;
    }
  }
  for (let a = 1; a < dim; a++) ata[a]![a]! += Math.max(1e-6, penalties[a - 1] ?? 1);
  const solved = solveSpd(ata, aty);
  if (!solved) return null;
  return { intercept: solved[0]!, coefficients: solved.slice(1) };
}
