/**
 * Bland-Altman agreement with repeated measures.
 *
 * The familiar limits of agreement — mean difference ± 1.96 SD — assume every
 * paired reading is an independent subject. Depth monitoring is the opposite:
 * one case contributes many readings that share a patient, a montage and an
 * anaesthetic. Pooling them as if independent distorts the limits, usually
 * making them look tighter than they are.
 *
 * This is the Bland & Altman (1999) repeated-measures decomposition: total
 * variance of the differences is split into a within-case and a between-case
 * component, and the limits are built from their sum.
 */

export interface RepeatedPair {
  caseKey: string;
  /** Model or app value. */
  predicted: number;
  /** Reference monitor value. */
  reference: number;
}

export interface RepeatedBlandAltman {
  n: number;
  cases: number;
  /** Mean difference (predicted − reference), the bias. */
  bias: number | null;
  /** Variance of the differences within a case. */
  withinVariance: number | null;
  /** Variance of the per-case mean differences. */
  betweenVariance: number | null;
  /** sqrt(within + between). */
  sd: number | null;
  /** Bias ± 1.96 × sd. */
  limits: [number, number] | null;
  /** Naive pooled limits, for comparison — what the classic formula gives. */
  naiveLimits: [number, number] | null;
  /** Intraclass correlation of the differences: how much a case explains. */
  icc: number | null;
  points: { mean: number; diff: number; caseKey: string }[];
  summary: string;
}

const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export function repeatedMeasuresBlandAltman(pairs: RepeatedPair[]): RepeatedBlandAltman {
  const usable = pairs.filter(
    (p) => Number.isFinite(p.predicted) && Number.isFinite(p.reference),
  );
  const points = usable.map((p) => ({
    mean: (p.predicted + p.reference) / 2,
    diff: p.predicted - p.reference,
    caseKey: p.caseKey,
  }));
  const diffs = points.map((p) => p.diff);
  const bias = avg(diffs);
  const byCase = new Map<string, number[]>();
  for (const p of points) byCase.set(p.caseKey, [...(byCase.get(p.caseKey) ?? []), p.diff]);
  const cases = byCase.size;

  if (bias == null || usable.length < 3) {
    return {
      n: usable.length,
      cases,
      bias: bias == null ? null : Number(bias.toFixed(2)),
      withinVariance: null,
      betweenVariance: null,
      sd: null,
      limits: null,
      naiveLimits: null,
      icc: null,
      points,
      summary: "Too few paired readings for limits of agreement.",
    };
  }

  // Within-case variance: pooled residual variance about each case mean.
  let withinSs = 0;
  let withinDf = 0;
  const caseMeans: { m: number; n: number }[] = [];
  for (const list of byCase.values()) {
    const m = avg(list)!;
    caseMeans.push({ m, n: list.length });
    if (list.length > 1) {
      withinSs += list.reduce((s, d) => s + (d - m) ** 2, 0);
      withinDf += list.length - 1;
    }
  }
  const withinVariance = withinDf > 0 ? withinSs / withinDf : 0;

  // Between-case variance of the case means, corrected for the within term
  // carried inside each mean (Bland & Altman 1999, eq. 5.3).
  let betweenVariance = 0;
  if (cases > 1) {
    const gm = avg(caseMeans.map((c) => c.m))!;
    const ss = caseMeans.reduce((s, c) => s + (c.m - gm) ** 2, 0) / (cases - 1);
    const totalN = usable.length;
    const sumSq = caseMeans.reduce((s, c) => s + c.n * c.n, 0);
    const divisor = (totalN * totalN - sumSq) / (totalN * (cases - 1));
    betweenVariance = Math.max(0, ss - (divisor > 0 ? withinVariance / divisor : 0));
  }

  const totalVar = withinVariance + betweenVariance;
  const sd = Math.sqrt(totalVar);
  const naiveSd = Math.sqrt(
    diffs.reduce((s, d) => s + (d - bias) ** 2, 0) / Math.max(1, diffs.length - 1),
  );
  const icc = totalVar > 0 ? betweenVariance / totalVar : null;
  const r2 = (v: number) => Number(v.toFixed(2));

  return {
    n: usable.length,
    cases,
    bias: r2(bias),
    withinVariance: r2(withinVariance),
    betweenVariance: r2(betweenVariance),
    sd: r2(sd),
    limits: [r2(bias - 1.96 * sd), r2(bias + 1.96 * sd)],
    naiveLimits: [r2(bias - 1.96 * naiveSd), r2(bias + 1.96 * naiveSd)],
    icc: icc == null ? null : Number(icc.toFixed(3)),
    points,
    summary: `Bias ${bias >= 0 ? "+" : ""}${bias.toFixed(1)} with limits of agreement ${(bias - 1.96 * sd).toFixed(1)} to ${(bias + 1.96 * sd).toFixed(1)} across ${usable.length} readings from ${cases} case${cases === 1 ? "" : "s"}${
      icc != null && icc > 0.2
        ? `; ${(icc * 100).toFixed(0)} % of the disagreement is between patients rather than within a case, so pooled limits would have been misleadingly tight`
        : ""
    }.`,
  };
}
