/**
 * BIS model (pure core).
 *
 * COEBIS aligns the app's published depth index onto the commercial BIS scale.
 * This is a different estimator: a direct regression of the recorded bedside
 * BIS number on the features the app actually measures at that moment — the
 * depth index, the spectral edge frequency and the suppression ratio. It is
 * fitted per acquisition lineage, scored with grouped cross-validation so no
 * case ever grades its own fit, and compared against whatever the app would
 * have said without it. Nothing here touches the database or promotes
 * anything; the gate below decides whether a fit has earned promotion.
 */

/** One paired bedside reading the model can learn from. */
export interface BisSample {
  /** Case the reading belongs to; folds are grouped by this. */
  caseRef: string;
  lineage: string;
  /** Recorded commercial BIS, 0–100. */
  bis: number;
  /** App depth index at the same moment, 0–100. */
  appIndex: number;
  /** Spectral edge frequency, Hz, when measured. */
  appSef: number | null;
  /** App suppression ratio, %, when measured. */
  appSr: number | null;
  /** Baseline estimate the app would publish without this model (COEBIS). */
  baseline: number;
}

export interface BisModel {
  lineage: string;
  /** Which terms the fit uses, in coefficient order (first is the intercept). */
  terms: string[];
  coefficients: number[];
  n: number;
  cases: number;
}

export interface BisMetrics {
  n: number;
  mae: number;
  rmse: number;
  /** Signed mean of (estimate − recorded BIS); negative reads deeper. */
  bias: number;
  correlation: number;
  /** Share of readings landing within 5 BIS points of the recorded number. */
  within5: number;
}

export interface BisFitReport {
  lineage: string;
  points: number;
  cases: number;
  folds: number;
  terms: string[];
  model: BisModel | null;
  /** Held-out accuracy of what the app says today, on the same readings. */
  before: BisMetrics | null;
  /** Cross-validated accuracy of the candidate BIS model. */
  after: BisMetrics | null;
  /** In-sample accuracy of the candidate, for reference only. */
  inSample: BisMetrics | null;
  maeGain: number | null;
  correlationGain: number | null;
  promotable: boolean;
  /** Why the fit was blocked, when it was. */
  blockedBy: string | null;
}

/** Fewest readings a lineage needs before a fit is allowed. */
export const MIN_FIT_POINTS = 400;
/** Fewest independent cases, so folds mean something. */
export const MIN_FIT_CASES = 5;
/** Held-out mean error must improve by at least this many BIS points. */
export const MIN_MAE_GAIN = 0.5;
/** A promotion may not cost more than this much correlation with real BIS. */
export const MAX_CORRELATION_LOSS = 0.02;
/** Cases are pooled into at most this many folds so a fit always terminates. */
export const MAX_FOLDS = 40;

const RIDGE = 1e-3;

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Which optional terms are measured often enough on this lineage to use. */
export function availableTerms(samples: BisSample[]): string[] {
  const terms = ["intercept", "index", "index2", "index3"];
  if (samples.length && samples.every((s) => Number.isFinite(s.appSef ?? NaN)))
    terms.push("sef", "sef2", "indexSef");
  const withSr = samples.filter((s) => Number.isFinite(s.appSr ?? NaN)).length;
  if (samples.length && withSr / samples.length >= 0.95) terms.push("sr", "sqrtSr", "srIndex");
  return terms;
}

function designRow(sample: BisSample, terms: string[]): number[] {
  const idx = sample.appIndex;
  const sr = Math.max(0, sample.appSr ?? 0);
  return terms.map((t) => {
    switch (t) {
      case "intercept":
        return 1;
      case "index":
        return idx;
      case "index2":
        return (idx * idx) / 100;
      case "index3":
        return (idx * idx * idx) / 10000;
      case "sef2":
        return ((sample.appSef ?? 0) * (sample.appSef ?? 0)) / 10;
      case "indexSef":
        return (idx * (sample.appSef ?? 0)) / 100;
      case "srIndex":
        return (idx * sr) / 100;
      case "sef":
        return sample.appSef ?? 0;
      case "sr":
        return sr;
      case "sqrtSr":
        return Math.sqrt(sr);
      default:
        return 0;
    }
  });
}

/** Solve (XᵀX + λI)β = Xᵀy by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] | null {
  const k = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]![col]!;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / p;
      if (!factor) continue;
      const rowR = m[r]!;
      const rowC = m[col]!;
      for (let c = col; c <= k; c++) rowR[c] = rowR[c]! - factor * rowC[c]!;
    }
  }
  return m.map((row, i) => row[k]! / m[i]![i]!);
}

/** Fit one BIS model on the readings given. Returns null when it cannot solve. */
export function fitBisModel(samples: BisSample[], terms = availableTerms(samples)): BisModel | null {
  if (samples.length < terms.length + 1) return null;
  const k = terms.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);
  for (const s of samples) {
    const row = designRow(s, terms);
    for (let i = 0; i < k; i++) {
      xty[i] += row[i]! * s.bis;
      const xr = xtx[i]!;
      for (let j = 0; j < k; j++) xr[j] = xr[j]! + row[i]! * row[j]!;
    }
  }
  for (let i = 1; i < k; i++) xtx[i]![i] = xtx[i]![i]! + RIDGE * samples.length;
  const beta = solve(xtx, xty);
  if (!beta || beta.some((v) => !Number.isFinite(v))) return null;
  return {
    lineage: samples[0]!.lineage,
    terms,
    coefficients: beta,
    n: samples.length,
    cases: new Set(samples.map((s) => s.caseRef)).size,
  };
}

/** What the model says the bedside monitor would read, clamped to the scale. */
export function predictBis(model: BisModel, sample: BisSample): number {
  const row = designRow(sample, model.terms);
  let sum = 0;
  for (let i = 0; i < model.coefficients.length; i++) sum += row[i]! * model.coefficients[i]!;
  return clamp(sum);
}

export function metricsOf(pairs: { predicted: number; bis: number }[]): BisMetrics | null {
  if (!pairs.length) return null;
  let absSum = 0;
  let sqSum = 0;
  let biasSum = 0;
  let within = 0;
  for (const p of pairs) {
    const d = p.predicted - p.bis;
    absSum += Math.abs(d);
    sqSum += d * d;
    biasSum += d;
    if (Math.abs(d) <= 5) within++;
  }
  const n = pairs.length;
  const meanP = pairs.reduce((a, p) => a + p.predicted, 0) / n;
  const meanB = pairs.reduce((a, p) => a + p.bis, 0) / n;
  let cov = 0;
  let vp = 0;
  let vb = 0;
  for (const p of pairs) {
    const dp = p.predicted - meanP;
    const db = p.bis - meanB;
    cov += dp * db;
    vp += dp * dp;
    vb += db * db;
  }
  const denom = Math.sqrt(vp * vb);
  return {
    n,
    mae: absSum / n,
    rmse: Math.sqrt(sqSum / n),
    bias: biasSum / n,
    correlation: denom > 0 ? cov / denom : 0,
    within5: within / n,
  };
}

/** Pool cases into folds so every reading is graded by a model that never saw its case. */
function foldsOf(samples: BisSample[]): BisSample[][] {
  const byCase = new Map<string, BisSample[]>();
  for (const s of samples) {
    const list = byCase.get(s.caseRef);
    if (list) list.push(s);
    else byCase.set(s.caseRef, [s]);
  }
  const cases = [...byCase.values()].sort((a, b) => b.length - a.length);
  const count = Math.min(MAX_FOLDS, cases.length);
  const folds: BisSample[][] = Array.from({ length: count }, () => []);
  cases.forEach((group, i) => folds[i % count]!.push(...group));
  return folds;
}

/** Fit, grade held-out, and decide whether the candidate has earned promotion. */
export function crossValidate(samples: BisSample[], lineage: string): BisFitReport {
  const cases = new Set(samples.map((s) => s.caseRef)).size;
  const terms = availableTerms(samples);
  const base: BisFitReport = {
    lineage,
    points: samples.length,
    cases,
    folds: 0,
    terms,
    model: null,
    before: null,
    after: null,
    inSample: null,
    maeGain: null,
    correlationGain: null,
    promotable: false,
    blockedBy: null,
  };

  if (samples.length < MIN_FIT_POINTS) {
    return { ...base, blockedBy: `only ${samples.length} paired readings, ${MIN_FIT_POINTS} needed` };
  }
  if (cases < MIN_FIT_CASES) {
    return { ...base, blockedBy: `only ${cases} cases, ${MIN_FIT_CASES} needed` };
  }

  const folds = foldsOf(samples);
  const held: { predicted: number; bis: number }[] = [];
  for (let i = 0; i < folds.length; i++) {
    const test = folds[i]!;
    const train = folds.filter((_, j) => j !== i).flat();
    const model = fitBisModel(train, terms);
    if (!model) continue;
    for (const s of test) held.push({ predicted: predictBis(model, s), bis: s.bis });
  }

  const model = fitBisModel(samples, terms);
  const before = metricsOf(samples.map((s) => ({ predicted: clamp(s.baseline), bis: s.bis })));
  const after = metricsOf(held);
  const inSample = model
    ? metricsOf(samples.map((s) => ({ predicted: predictBis(model, s), bis: s.bis })))
    : null;

  if (!model || !before || !after) {
    return { ...base, folds: folds.length, model, before, after, inSample, blockedBy: "the fit could not be solved" };
  }

  const maeGain = before.mae - after.mae;
  const correlationGain = after.correlation - before.correlation;
  let blockedBy: string | null = null;
  if (maeGain < MIN_MAE_GAIN) {
    blockedBy = `held-out error improves by only ${maeGain.toFixed(2)} points, ${MIN_MAE_GAIN} needed`;
  } else if (correlationGain < -MAX_CORRELATION_LOSS) {
    blockedBy = `agreement with the monitor drops by ${Math.abs(correlationGain).toFixed(3)}`;
  }

  return {
    ...base,
    folds: folds.length,
    model,
    before,
    after,
    inSample,
    maeGain,
    correlationGain,
    promotable: blockedBy == null,
    blockedBy,
  };
}
