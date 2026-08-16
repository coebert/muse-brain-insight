/**
 * Covariate-aware COEBIS: the fitting and honest-validation layer.
 *
 * COEBIS v2 is a single pooled affine + knot map — the same correction for
 * every patient. That is exactly the limitation of commercial BIS. This module
 * adds a second stage: after the pooled map, it learns a small additive
 * residual correction per covariate level (age band, sex, drug regimen,
 * frailty), each shrunk toward zero so a handful of readings in a subgroup
 * cannot swing the number, and optionally a per-case random intercept.
 *
 * Nothing here is trusted on face value: `crossValidateByCase` refits the whole
 * pipeline leaving one case out at a time, so every improvement quoted to a
 * clinician is an out-of-sample improvement on cases the model never saw.
 */

import { fitAlignment, type BisDriftPoint } from "./bis-drift";
import { knotCorrection, type BisKnot } from "./depth";
import {
  covariateAdjustment,
  covariateLevels,
  MAX_TERM_ADJUSTMENT,
  type CaseCovariates,
  type CovariateTerm,
} from "./covariates";

/** A paired reading with everything known about the patient and the drugs. */
export interface CoebisTrainingPoint extends BisDriftPoint {
  cov: CaseCovariates;
  /** Effect-site targets at the moment of the reading, per drug. */
  ce?: Record<string, number> | null;
  /** App suppression ratio at the reading, %. */
  appSr?: number | null;
}

export type CoebisFamily = "raw" | "affine" | "covariate" | "mixed";

export interface CoebisModel {
  family: CoebisFamily;
  gain: number;
  offset: number;
  knots: BisKnot[];
  terms: CovariateTerm[];
  /** Per-case intercepts, used only in-sample (mixed family). */
  caseIntercepts: Record<string, number>;
  n: number;
  sessions: number;
}

export interface AgreementSummary {
  n: number;
  /** Mean (prediction − BIS); positive = model reads lighter. */
  bias: number | null;
  mae: number | null;
  rmse: number | null;
  /** Share of predictions within 5 index points of the monitor. */
  within5: number | null;
  within10: number | null;
  /** Lin's concordance correlation coefficient. */
  ccc: number | null;
}

/** Shrinkage sample size for each covariate level. */
const TERM_SHRINK_K = 20;
/** Shrinkage sample size for a per-case intercept. */
const CASE_SHRINK_K = 12;
/** Fewer readings than this in a level and the level is left alone. */
const MIN_LEVEL_POINTS = 4;

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const r2 = (v: number | null, dp = 2) =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

/** The pooled part of the prediction: affine map plus knot shaping. */
function shaped(model: { gain: number; offset: number; knots: BisKnot[] }, index: number): number {
  const affine = model.gain * index + model.offset;
  return affine + knotCorrection(affine, model.knots);
}

/**
 * Predict a commercial-scale value for one reading. `useCaseIntercept` is only
 * ever true in-sample: for an unseen case the random intercept is zero, which
 * is what makes leave-one-case-out validation honest.
 */
export function predictCoebis(
  model: CoebisModel,
  point: { appIndex: number; cov?: CaseCovariates | null; sessionId?: string | null },
  useCaseIntercept = false,
): number {
  if (model.family === "raw") return point.appIndex;
  let v = shaped(model, point.appIndex);
  if (model.family === "covariate" || model.family === "mixed") {
    v += covariateAdjustment(model.terms, point.cov ?? null).total;
  }
  if (useCaseIntercept && model.family === "mixed") {
    v += model.caseIntercepts[point.sessionId ?? "unfiled"] ?? 0;
  }
  return Math.min(100, Math.max(0, v));
}

/**
 * Learn one shrunk correction per covariate level from the residuals left by
 * the pooled map. Levels seen only a handful of times collapse toward zero.
 */
export function fitCovariateTerms(
  points: CoebisTrainingPoint[],
  base: { gain: number; offset: number; knots: BisKnot[] },
): CovariateTerm[] {
  const buckets = new Map<string, { group: string; level: string; residuals: number[] }>();
  for (const p of points) {
    const residual = p.bis - shaped(base, p.appIndex);
    if (!Number.isFinite(residual)) continue;
    for (const [group, level] of covariateLevels(p.cov)) {
      const key = `${group}:${level}`;
      const bucket = buckets.get(key) ?? { group, level, residuals: [] };
      bucket.residuals.push(residual);
      buckets.set(key, bucket);
    }
  }
  const terms: CovariateTerm[] = [];
  for (const b of buckets.values()) {
    const n = b.residuals.length;
    if (n < MIN_LEVEL_POINTS) continue;
    const m = mean(b.residuals)!;
    const lambda = n / (n + TERM_SHRINK_K);
    const dy = Math.max(-MAX_TERM_ADJUSTMENT, Math.min(MAX_TERM_ADJUSTMENT, lambda * m));
    if (Math.abs(dy) < 0.2) continue;
    terms.push({ group: b.group, level: b.level, dy: Number(dy.toFixed(2)), n });
  }
  return terms.sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy));
}

/** Shrunk mean residual per case, after the pooled map and covariate terms. */
function fitCaseIntercepts(
  points: CoebisTrainingPoint[],
  base: { gain: number; offset: number; knots: BisKnot[]; terms: CovariateTerm[] },
): Record<string, number> {
  const byCase = new Map<string, number[]>();
  for (const p of points) {
    const key = p.sessionId ?? "unfiled";
    const pred = shaped(base, p.appIndex) + covariateAdjustment(base.terms, p.cov).total;
    const list = byCase.get(key) ?? [];
    list.push(p.bis - pred);
    byCase.set(key, list);
  }
  const out: Record<string, number> = {};
  for (const [key, residuals] of byCase) {
    const n = residuals.length;
    if (n < 3) continue;
    const lambda = n / (n + CASE_SHRINK_K);
    out[key] = Number((lambda * mean(residuals)!).toFixed(2));
  }
  return out;
}

/** Fit the requested model family on the supplied readings. */
export function fitCoebisModel(
  points: CoebisTrainingPoint[],
  family: CoebisFamily,
): CoebisModel | null {
  const sessions = new Set(points.map((p) => p.sessionId ?? "unfiled")).size;
  if (family === "raw") {
    return {
      family,
      gain: 1,
      offset: 0,
      knots: [],
      terms: [],
      caseIntercepts: {},
      n: points.length,
      sessions,
    };
  }
  const affine = fitAlignment(points);
  if (!affine) return null;
  const base = { gain: affine.gain, offset: affine.offset, knots: affine.knots };
  const terms = family === "affine" ? [] : fitCovariateTerms(points, base);
  const caseIntercepts =
    family === "mixed" ? fitCaseIntercepts(points, { ...base, terms }) : {};
  return { family, ...base, terms, caseIntercepts, n: points.length, sessions };
}

/** Agreement of a set of predictions with the transcribed monitor values. */
export function agreementSummary(
  pairs: { predicted: number; bis: number }[],
): AgreementSummary {
  const n = pairs.length;
  if (!n) return { n: 0, bias: null, mae: null, rmse: null, within5: null, within10: null, ccc: null };
  const diffs = pairs.map((p) => p.predicted - p.bis);
  const xs = pairs.map((p) => p.predicted);
  const ys = pairs.map((p) => p.bis);
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const vx = sxx / n;
  const vy = syy / n;
  const cov = sxy / n;
  const denom = vx + vy + (mx - my) ** 2;
  return {
    n,
    bias: r2(mean(diffs)),
    mae: r2(mean(diffs.map(Math.abs))),
    rmse: r2(Math.sqrt(mean(diffs.map((d) => d * d))!)),
    within5: r2((pairs.filter((p) => Math.abs(p.predicted - p.bis) <= 5).length / n) * 100, 1),
    within10: r2((pairs.filter((p) => Math.abs(p.predicted - p.bis) <= 10).length / n) * 100, 1),
    ccc: denom < 1e-9 ? null : r2((2 * cov) / denom, 3),
  };
}

export interface CoebisCvResult {
  family: CoebisFamily;
  /** Out-of-sample: every prediction came from a model fitted without that case. */
  outOfSample: AgreementSummary;
  /** In-sample fit on all data, for comparison only. */
  inSample: AgreementSummary;
  /** Cases that could be held out (needed ≥ 2 cases). */
  folds: number;
}

/**
 * Leave-one-case-out cross-validation. Each case is held out in turn, the model
 * is refitted on the rest, and the held-out readings are predicted with no
 * knowledge of that patient — the only fair way to claim the model generalises.
 */
export function crossValidateByCase(
  points: CoebisTrainingPoint[],
  family: CoebisFamily,
): CoebisCvResult {
  const caseKeys = [...new Set(points.map((p) => p.sessionId ?? "unfiled"))];
  const full = fitCoebisModel(points, family);
  const inSample = full
    ? agreementSummary(points.map((p) => ({ predicted: predictCoebis(full, p, true), bis: p.bis })))
    : agreementSummary([]);

  const predictions: { predicted: number; bis: number }[] = [];
  let folds = 0;
  if (caseKeys.length >= 2) {
    for (const key of caseKeys) {
      const train = points.filter((p) => (p.sessionId ?? "unfiled") !== key);
      const test = points.filter((p) => (p.sessionId ?? "unfiled") === key);
      if (train.length < 5 || !test.length) continue;
      const model = fitCoebisModel(train, family);
      if (!model) continue;
      folds++;
      for (const p of test) predictions.push({ predicted: predictCoebis(model, p, false), bis: p.bis });
    }
  }
  return { family, outOfSample: agreementSummary(predictions), inSample, folds };
}

export interface StratumResult {
  group: string;
  level: string;
  n: number;
  cases: number;
  before: AgreementSummary;
  after: AgreementSummary;
}

/**
 * Out-of-fold prediction for every reading: each one comes from a model fitted
 * without that reading's case. Returned in the same order as `points`, with
 * null where no fold could be fitted.
 */
export function outOfFoldPredictions(
  points: CoebisTrainingPoint[],
  family: CoebisFamily,
): (number | null)[] {
  const out: (number | null)[] = points.map(() => null);
  const caseKeys = [...new Set(points.map((p) => p.sessionId ?? "unfiled"))];
  if (caseKeys.length < 2) return out;
  for (const key of caseKeys) {
    const train = points.filter((p) => (p.sessionId ?? "unfiled") !== key);
    if (train.length < 5) continue;
    const model = fitCoebisModel(train, family);
    if (!model) continue;
    points.forEach((p, i) => {
      if ((p.sessionId ?? "unfiled") === key) out[i] = predictCoebis(model, p, false);
    });
  }
  return out;
}

/** Held-out error broken down by subgroup, so weak spots cannot hide in a mean. */
export function stratifiedAgreement(
  points: CoebisTrainingPoint[],
  predict: (p: CoebisTrainingPoint, index: number) => number | null,
): StratumResult[] {
  const buckets = new Map<string, { p: CoebisTrainingPoint; i: number }[]>();
  const push = (group: string, level: string, p: CoebisTrainingPoint, i: number) => {
    const key = `${group}\u0000${level}`;
    buckets.set(key, [...(buckets.get(key) ?? []), { p, i }]);
  };
  points.forEach((p, i) => {
    for (const [group, level] of covariateLevels(p.cov)) push(group, level, p, i);
    const band =
      p.bis >= 80
        ? "80-100 (awake)"
        : p.bis >= 60
          ? "60-79 (light)"
          : p.bis >= 40
            ? "40-59 (surgical)"
            : "<40 (deep)";
    push("depth", band, p, i);
  });
  return [...buckets.entries()]
    .map(([key, list]) => {
      const [group = "", level = ""] = key.split("\u0000");
      const scored = list
        .map((e) => ({ predicted: predict(e.p, e.i), bis: e.p.bis }))
        .filter((e): e is { predicted: number; bis: number } => e.predicted != null);
      return {
        group,
        level,
        n: list.length,
        cases: new Set(list.map((e) => e.p.sessionId ?? "unfiled")).size,
        before: agreementSummary(list.map((e) => ({ predicted: e.p.appIndex, bis: e.p.bis }))),
        after: agreementSummary(scored),
      };
    })
    .sort((a, b) => (a.group === b.group ? b.n - a.n : a.group.localeCompare(b.group)));
}

export interface SubgroupGap {
  group: string;
  level: string;
  have: number;
  need: number;
  cases: number;
}

/** Readings still needed before a subgroup earns its own correction. */
export function subgroupGaps(
  points: CoebisTrainingPoint[],
  expected: { group: string; levels: string[] }[],
  need = 15,
): SubgroupGap[] {
  const counts = new Map<string, CoebisTrainingPoint[]>();
  for (const p of points) {
    for (const [group, level] of covariateLevels(p.cov)) {
      const key = `${group}\u0000${level}`;
      counts.set(key, [...(counts.get(key) ?? []), p]);
    }
  }
  const gaps: SubgroupGap[] = [];
  for (const spec of expected) {
    for (const level of spec.levels) {
      const list = counts.get(`${spec.group}\u0000${level}`) ?? [];
      if (list.length >= need) continue;
      gaps.push({
        group: spec.group,
        level,
        have: list.length,
        need,
        cases: new Set(list.map((p) => p.sessionId ?? "unfiled")).size,
      });
    }
  }
  return gaps.sort((a, b) => a.have - b.have);
}
