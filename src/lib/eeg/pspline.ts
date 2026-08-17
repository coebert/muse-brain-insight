/**
 * Penalised, monotone correction curve for COEBIS.
 *
 * The original knot map learned each of the seven residual corrections
 * independently, from whichever readings happened to fall near it. Two
 * problems follow: a knot with a handful of noisy readings wobbles freely
 * against its neighbours, and nothing stops the finished map from running
 * backwards — a higher raw index producing a lower COEBIS, which is
 * clinically indefensible.
 *
 * This module fits all knots at once as a piecewise-linear (P-spline) basis
 * with a second-difference roughness penalty, chooses the penalty strength by
 * cross-validation across cases, and then projects the fitted curve onto the
 * set of monotone non-decreasing maps. The output is the same `BisKnot[]` the
 * rest of the app already understands.
 */

import type { BisKnot } from "./depth";

export interface SplineSample {
  /** Position on the aligned scale. */
  x: number;
  /** Residual to explain (BIS − aligned index). */
  r: number;
  /** Fitting weight. */
  w: number;
  /** Case the reading came from, for cross-validated smoothing. */
  caseKey: string;
}

export interface PenalisedKnotFit {
  knots: BisKnot[];
  /** Chosen roughness penalty. */
  lambda: number;
  /** Cross-validated mean absolute residual at that penalty. */
  cvMae: number | null;
  /** Knots the monotonicity projection had to move. */
  monotoneAdjusted: number;
  /** Effective readings behind the curve. */
  n: number;
}

/** Candidate penalty strengths, log-spaced from nearly-free to nearly-flat. */
export const LAMBDA_GRID = [0.5, 2, 8, 32, 128, 512, 2048];

/** Piecewise-linear basis weights at `x` for the given knot positions. */
export function hatBasis(x: number, positions: number[]): number[] {
  const b = new Array(positions.length).fill(0);
  if (!positions.length) return b;
  if (x <= positions[0]!) {
    b[0] = 1;
    return b;
  }
  const last = positions.length - 1;
  if (x >= positions[last]!) {
    b[last] = 1;
    return b;
  }
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1]!;
    const c = positions[i]!;
    if (x <= c) {
      const t = (x - a) / (c - a || 1);
      b[i - 1] = 1 - t;
      b[i] = t;
      return b;
    }
  }
  b[last] = 1;
  return b;
}

/** Solve a symmetric positive-definite system by Gaussian elimination. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
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

/** Ridge-and-roughness penalised weighted least squares over the hat basis. */
function fitCoefficients(
  samples: SplineSample[],
  positions: number[],
  lambda: number,
): number[] | null {
  const k = positions.length;
  const ata: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const aty: number[] = new Array(k).fill(0);
  for (const s of samples) {
    const b = hatBasis(s.x, positions);
    for (let i = 0; i < k; i++) {
      if (!b[i]) continue;
      aty[i]! += s.w * b[i]! * s.r;
      for (let j = 0; j < k; j++) {
        if (!b[j]) continue;
        ata[i]![j]! += s.w * b[i]! * b[j]!;
      }
    }
  }
  // Second-difference penalty: neighbouring corrections must line up unless
  // the data insists otherwise.
  for (let i = 0; i + 2 < k; i++) {
    const row = [1, -2, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        ata[i + a]![i + b]! += lambda * row[a]! * row[b]!;
      }
    }
  }
  // A whisper of ridge keeps unvisited knots at zero rather than undetermined.
  for (let i = 0; i < k; i++) ata[i]![i]! += 0.5;
  return solve(ata, aty);
}

function predict(coefficients: number[], positions: number[], x: number): number {
  const b = hatBasis(x, positions);
  return b.reduce((s, v, i) => s + v * (coefficients[i] ?? 0), 0);
}

/**
 * Pool-adjacent-violators projection: force the finished map
 * `x + dy(x)` to be non-decreasing across the knots.
 */
export function projectMonotone(
  positions: number[],
  dy: number[],
): { dy: number[]; adjusted: number } {
  const values = positions.map((x, i) => x + (dy[i] ?? 0));
  const blocks: { sum: number; count: number }[] = [];
  for (const v of values) {
    blocks.push({ sum: v, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.sum / prev.count <= last.sum / last.count) break;
      blocks.splice(blocks.length - 2, 2, {
        sum: prev.sum + last.sum,
        count: prev.count + last.count,
      });
    }
  }
  const flat: number[] = [];
  for (const b of blocks) {
    for (let i = 0; i < b.count; i++) flat.push(b.sum / b.count);
  }
  let adjusted = 0;
  const out = positions.map((x, i) => {
    const next = flat[i]! - x;
    if (Math.abs(next - (dy[i] ?? 0)) > 0.01) adjusted++;
    return next;
  });
  return { dy: out, adjusted };
}

/**
 * Fit the COEBIS residual curve: joint penalised fit, penalty chosen by
 * leave-one-case-out error, then projected monotone and capped.
 */
export function fitPenalisedKnots(
  samples: SplineSample[],
  positions: number[],
  maxCorrection: number,
): PenalisedKnotFit {
  const zero: BisKnot[] = positions.map((x) => ({ x, dy: 0 }));
  const usable = samples.filter(
    (s) => Number.isFinite(s.x) && Number.isFinite(s.r) && s.w > 0,
  );
  if (usable.length < 5) {
    return { knots: zero, lambda: LAMBDA_GRID[LAMBDA_GRID.length - 1]!, cvMae: null, monotoneAdjusted: 0, n: usable.length };
  }

  const caseKeys = [...new Set(usable.map((s) => s.caseKey))];
  let bestLambda = LAMBDA_GRID[LAMBDA_GRID.length - 1]!;
  let bestMae: number | null = null;
  if (caseKeys.length >= 2) {
    for (const lambda of LAMBDA_GRID) {
      let absSum = 0;
      let count = 0;
      for (const key of caseKeys) {
        const train = usable.filter((s) => s.caseKey !== key);
        const test = usable.filter((s) => s.caseKey === key);
        if (train.length < 5 || !test.length) continue;
        const coefficients = fitCoefficients(train, positions, lambda);
        if (!coefficients) continue;
        for (const s of test) {
          absSum += Math.abs(s.r - predict(coefficients, positions, s.x));
          count++;
        }
      }
      if (!count) continue;
      const mae = absSum / count;
      if (bestMae == null || mae < bestMae) {
        bestMae = mae;
        bestLambda = lambda;
      }
    }
  }

  const coefficients = fitCoefficients(usable, positions, bestLambda);
  if (!coefficients) {
    return { knots: zero, lambda: bestLambda, cvMae: bestMae, monotoneAdjusted: 0, n: usable.length };
  }
  const capped = coefficients.map((c) =>
    Math.max(-maxCorrection, Math.min(maxCorrection, Number.isFinite(c) ? c : 0)),
  );
  const projected = projectMonotone(positions, capped);
  const knots = positions.map((x, i) => ({
    x,
    dy: Number(
      Math.max(-maxCorrection, Math.min(maxCorrection, projected.dy[i] ?? 0)).toFixed(2),
    ),
  }));
  return {
    knots,
    lambda: bestLambda,
    cvMae: bestMae == null ? null : Number(bestMae.toFixed(3)),
    monotoneAdjusted: projected.adjusted,
    n: usable.length,
  };
}
