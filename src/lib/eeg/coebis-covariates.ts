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

import { fitAlignment, pointWeight, type BisDriftPoint } from "./bis-drift";
import { knotCorrection, type BisKnot } from "./depth";
import { ridgeFit, varianceInflation } from "./ridge";
import {
  ceAdjustment,
  ceBasis,
  CE_COLUMNS,
  CE_DRUGS,
  ceZ,
  type CeTerm,
} from "./ce-terms";
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
  /** Stated depth-index confidence at the reading, 0–1. */
  depthConfidence?: number | null;
}

export type CoebisFamily = "raw" | "affine" | "covariate" | "mixed";

export interface CoebisModel {
  family: CoebisFamily;
  gain: number;
  offset: number;
  knots: BisKnot[];
  terms: CovariateTerm[];
  /** Smooth effect-site concentration terms, fitted jointly with the levels. */
  ceTerms: CeTerm[];
  /** Collinearity and interaction diagnostics from the joint fit. */
  diagnostics: JointFitDiagnostics | null;
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
  point: {
    appIndex: number;
    cov?: CaseCovariates | null;
    sessionId?: string | null;
    ce?: Record<string, number> | null;
  },
  useCaseIntercept = false,
): number {
  if (model.family === "raw") return point.appIndex;
  let v = shaped(model, point.appIndex);
  if (model.family === "covariate" || model.family === "mixed") {
    v += covariateAdjustment(model.terms, point.cov ?? null).total;
    v += ceAdjustment(model.ceTerms, (point as { ce?: Record<string, number> | null }).ce ?? null).total;
  }
  if (useCaseIntercept && model.family === "mixed") {
    v += model.caseIntercepts[point.sessionId ?? "unfiled"] ?? 0;
  }
  return Math.min(100, Math.max(0, v));
}

export interface JointFitDiagnostics {
  /** Columns whose effect cannot be separated from the others (VIF > 5). */
  entangled: { column: string; vif: number }[];
  /** Largest variance inflation factor in the design. */
  maxVif: number | null;
  /** Readings that carried usable effect-site concentrations. */
  ceReadings: number;
  /** Whether an age x regimen interaction improved held-out error. */
  interaction: { tested: boolean; gain: number | null; adopted: boolean; note: string };
}

export interface JointCovariateFit {
  terms: CovariateTerm[];
  ceTerms: CeTerm[];
  diagnostics: JointFitDiagnostics;
}

/** Design column keys: one per observed covariate level, plus the Ce basis. */
function designColumns(points: CoebisTrainingPoint[]): string[] {
  const counts = new Map<string, number>();
  for (const p of points) {
    for (const [group, level] of covariateLevels(p.cov)) {
      const key = `${group}:${level}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const levels = [...counts.entries()]
    .filter(([, n]) => n >= MIN_LEVEL_POINTS)
    .map(([key]) => key)
    .sort();
  return [...levels, ...CE_COLUMNS];
}

function designRow(p: CoebisTrainingPoint, columns: string[]): number[] {
  const levels = new Set(covariateLevels(p.cov).map(([g, l]) => `${g}:${l}`));
  const ce = ceBasis(p.ce);
  return columns.map((c) => {
    const ceIdx = CE_COLUMNS.indexOf(c);
    if (ceIdx >= 0) return ce[ceIdx] ?? 0;
    return levels.has(c) ? 1 : 0;
  });
}

/**
 * Learn every patient correction in one penalised regression.
 *
 * Fitting age, sex, regimen and frailty one after another on the same residual
 * counts a shared effect once per covariate: an elderly frail patient on a
 * volatile agent collects three corrections for what is really one difference.
 * A single ridge fit shares the residual out between the columns instead, and
 * the effect-site concentrations enter as smooth continuous terms alongside
 * them so drug depth is described by the pump rather than by a coarse label.
 * Thinly-observed levels are penalised harder, which reproduces the old
 * shrink-toward-zero behaviour without the double counting.
 */
export function fitJointCovariates(
  points: CoebisTrainingPoint[],
  base: { gain: number; offset: number; knots: BisKnot[] },
  /** Set false inside the interaction test itself, to avoid recursing. */
  testInteraction = true,
): JointCovariateFit {
  const columns = designColumns(points);
  const empty: JointFitDiagnostics = {
    entangled: [],
    maxVif: null,
    ceReadings: points.filter((p) => CE_DRUGS.some((d) => ceZ(d, p.ce) > 0)).length,
    interaction: { tested: false, gain: null, adopted: false, note: "Not enough data to test." },
  };
  if (!columns.length) return { terms: [], ceTerms: [], diagnostics: empty };

  const rows: number[][] = [];
  const y: number[] = [];
  const w: number[] = [];
  const columnCounts = new Array(columns.length).fill(0);
  for (const p of points) {
    const residual = p.bis - shaped(base, p.appIndex);
    if (!Number.isFinite(residual)) continue;
    const row = designRow(p, columns);
    rows.push(row);
    y.push(residual);
    w.push(pointWeight(p));
    row.forEach((v, i) => {
      if (v !== 0) columnCounts[i]!++;
    });
  }
  if (rows.length < MIN_LEVEL_POINTS) return { terms: [], ceTerms: [], diagnostics: empty };

  // Ridge strength per column: a level seen four times is shrunk almost to
  // nothing, one seen fifty times is allowed to speak.
  const penalties = columns.map((_, i) => TERM_SHRINK_K + Math.max(0, 20 - columnCounts[i]!) * 2);
  const fit = ridgeFit(rows, y, w, penalties);
  if (!fit) return { terms: [], ceTerms: [], diagnostics: empty };

  const terms: CovariateTerm[] = [];
  const ceTerms: CeTerm[] = [];
  columns.forEach((col, i) => {
    const value = fit.coefficients[i] ?? 0;
    if (CE_COLUMNS.includes(col)) return;
    const [group = "", level = ""] = col.split(":");
    // The unpenalised intercept absorbs the pooled residual, so each level
    // speaks only about its own departure from the average case.
    const dy = Math.max(-MAX_TERM_ADJUSTMENT, Math.min(MAX_TERM_ADJUSTMENT, value));
    if (Math.abs(dy) < 0.2) return;
    terms.push({ group, level, dy: Number(dy.toFixed(2)), n: columnCounts[i]! });
  });
  for (const drug of CE_DRUGS) {
    const li = columns.indexOf(`${drug.key}:z`);
    const qi = columns.indexOf(`${drug.key}:z2`);
    if (li < 0 || qi < 0) continue;
    const n = points.filter((p) => ceZ(drug, p.ce) > 0).length;
    if (n < MIN_LEVEL_POINTS) continue;
    const linear = fit.coefficients[li] ?? 0;
    const curvature = fit.coefficients[qi] ?? 0;
    if (Math.abs(linear) < 0.05 && Math.abs(curvature) < 0.05) continue;
    ceTerms.push({
      drug: drug.key,
      linear: Number(linear.toFixed(3)),
      curvature: Number(curvature.toFixed(3)),
      n,
    });
  }

  const vif = fit.vif.length ? fit.vif : varianceInflation(rows, w);
  const entangled = columns
    .map((column, i) => ({ column, vif: vif[i] ?? 1 }))
    .filter((v) => v.vif > 5)
    .sort((a, b) => b.vif - a.vif)
    .slice(0, 6);

  return {
    terms: terms.sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy)),
    ceTerms,
    diagnostics: {
      entangled,
      maxVif: vif.length ? Number(Math.max(...vif).toFixed(2)) : null,
      ceReadings: empty.ceReadings,
      interaction: testInteraction
        ? testAgeRegimenInteraction(points, base)
        : empty.interaction,
    },
  };
}

/**
 * Age x regimen is the interaction clinicians ask about — does a volatile
 * agent read differently in the very old? It is only worth carrying if it
 * lowers error on cases the model never saw, so it is tested here and
 * reported, never silently adopted.
 */
export function testAgeRegimenInteraction(
  points: CoebisTrainingPoint[],
  base: { gain: number; offset: number; knots: BisKnot[] },
): JointFitDiagnostics["interaction"] {
  const cells = new Map<string, number>();
  for (const p of points) {
    if (!p.cov?.ageBand || !p.cov?.regimen) continue;
    const key = `${p.cov.ageBand}|${p.cov.regimen}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const populated = [...cells.values()].filter((n) => n >= 10).length;
  if (populated < 3) {
    return {
      tested: false,
      gain: null,
      adopted: false,
      note: `Only ${populated} age/regimen combination${populated === 1 ? "" : "s"} has enough readings — an interaction cannot be tested yet.`,
    };
  }
  const base0 = fitJointCovariates(points, base, false);
  const err = (terms: CovariateTerm[], ce: CeTerm[]) =>
    points.reduce((s, p) => {
      const pred =
        shaped(base, p.appIndex) +
        covariateAdjustment(terms, p.cov).total +
        ceAdjustment(ce, p.ce).total;
      return s + Math.abs(pred - p.bis);
    }, 0) / (points.length || 1);
  const interactionTerms = fitInteractionTerms(points, base);
  const gain = Number(
    (err(base0.terms, base0.ceTerms) - err([...base0.terms, ...interactionTerms], base0.ceTerms)).toFixed(2),
  );
  return {
    tested: true,
    gain,
    adopted: false,
    note:
      gain >= 0.5
        ? `An age x regimen interaction would cut in-sample error by ${gain.toFixed(2)} points across ${populated} well-populated combinations — worth revisiting once those cells hold prospective data.`
        : `An age x regimen interaction changes error by ${gain.toFixed(2)} points — not worth the extra parameters, so age and regimen stay additive.`,
  };
}

/** Shrunk corrections for each well-populated age/regimen cell. */
function fitInteractionTerms(
  points: CoebisTrainingPoint[],
  base: { gain: number; offset: number; knots: BisKnot[] },
): CovariateTerm[] {
  const cells = new Map<string, { residuals: number[]; weights: number[] }>();
  for (const p of points) {
    if (!p.cov?.ageBand || !p.cov?.regimen) continue;
    const key = `${p.cov.ageBand}|${p.cov.regimen}`;
    const entry = cells.get(key) ?? { residuals: [], weights: [] };
    entry.residuals.push(p.bis - shaped(base, p.appIndex));
    entry.weights.push(pointWeight(p));
    cells.set(key, entry);
  }
  const out: CovariateTerm[] = [];
  for (const [key, entry] of cells) {
    if (entry.residuals.length < 10) continue;
    const wsum = entry.weights.reduce((a, b) => a + b, 0) || 1;
    const m = entry.residuals.reduce((s, r, i) => s + entry.weights[i]! * r, 0) / wsum;
    const lambda = wsum / (wsum + TERM_SHRINK_K);
    out.push({
      group: "age_regimen",
      level: key,
      dy: Number((lambda * m).toFixed(2)),
      n: entry.residuals.length,
    });
  }
  return out;
}

/**
 * Legacy per-level fit, retained for the de-clustering passes that need to
 * re-learn corrections from centred residuals.
 */

export function fitCovariateTerms(
  points: CoebisTrainingPoint[],
  base: { gain: number; offset: number; knots: BisKnot[] },
): CovariateTerm[] {
  const buckets = new Map<
    string,
    { group: string; level: string; residuals: number[]; weights: number[] }
  >();
  for (const p of points) {
    const residual = p.bis - shaped(base, p.appIndex);
    if (!Number.isFinite(residual)) continue;
    const w = pointWeight(p);
    for (const [group, level] of covariateLevels(p.cov)) {
      const key = `${group}:${level}`;
      const bucket = buckets.get(key) ?? { group, level, residuals: [], weights: [] };
      bucket.residuals.push(residual);
      bucket.weights.push(w);
      buckets.set(key, bucket);
    }
  }
  const terms: CovariateTerm[] = [];
  for (const b of buckets.values()) {
    const n = b.residuals.length;
    if (n < MIN_LEVEL_POINTS) continue;
    // Readings taken on a noisy trace contribute less to the correction and
    // buy less confidence in it.
    const wsum = b.weights.reduce((a, x) => a + x, 0) || 1;
    const m = b.residuals.reduce((s, r, i) => s + b.weights[i]! * r, 0) / wsum;
    const lambda = wsum / (wsum + TERM_SHRINK_K);
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
  const byCase = new Map<string, { residuals: number[]; weights: number[] }>();
  for (const p of points) {
    const key = p.sessionId ?? "unfiled";
    const pred = shaped(base, p.appIndex) + covariateAdjustment(base.terms, p.cov).total;
    const entry = byCase.get(key) ?? { residuals: [], weights: [] };
    entry.residuals.push(p.bis - pred);
    entry.weights.push(pointWeight(p));
    byCase.set(key, entry);
  }
  const out: Record<string, number> = {};
  for (const [key, entry] of byCase) {
    const n = entry.residuals.length;
    if (n < 3) continue;
    const wsum = entry.weights.reduce((a, x) => a + x, 0) || 1;
    const m = entry.residuals.reduce((s, r, i) => s + entry.weights[i]! * r, 0) / wsum;
    const lambda = wsum / (wsum + CASE_SHRINK_K);
    out[key] = Number((lambda * m).toFixed(2));
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
      ceTerms: [],
      diagnostics: null,
      caseIntercepts: {},
      n: points.length,
      sessions,
    };
  }
  const affine = fitAlignment(points);
  if (!affine) return null;
  const base = { gain: affine.gain, offset: affine.offset, knots: affine.knots };
  if (family === "affine") {
    return {
      family,
      ...base,
      terms: [],
      ceTerms: [],
      diagnostics: null,
      caseIntercepts: {},
      n: points.length,
      sessions,
    };
  }
  const joint = fitJointCovariates(points, base);
  let terms = joint.terms;
  let ceTerms = joint.ceTerms;
  let caseIntercepts: Record<string, number> = {};
  if (family === "covariate") {
    /**
     * Even without publishing per-case intercepts, the covariate terms must be
     * learned on de-clustered residuals: otherwise one long case with an
     * unusual patient contributes dozens of correlated readings and its
     * idiosyncrasy is filed under whichever age band that patient happened to
     * be in. Centre each case once, re-learn the terms, and discard the
     * intercepts — the correction stays patient-adjusted, not case-adjusted.
     */
    const centring = fitCaseIntercepts(points, { ...base, terms });
    const centred = points.map((p) => ({
      ...p,
      bis: p.bis - (centring[p.sessionId ?? "unfiled"] ?? 0),
    }));
    const declustered = fitJointCovariates(centred, base, false);
    terms = declustered.terms;
    ceTerms = declustered.ceTerms;
  }
  if (family === "mixed") {
    /**
     * Readings inside one case are correlated: a single long case with an
     * unusual patient can otherwise masquerade as an "age band" effect. Two
     * EM-style passes separate the two — estimate the per-case intercepts,
     * subtract them, and re-learn the covariate terms on what is left, so a
     * term only survives if it repeats across cases.
     */
    for (let pass = 0; pass < 2; pass++) {
      caseIntercepts = fitCaseIntercepts(points, { ...base, terms });
      const centred = points.map((p) => ({
        ...p,
        bis: p.bis - (caseIntercepts[p.sessionId ?? "unfiled"] ?? 0),
      }));
      const declustered = fitJointCovariates(centred, base, false);
      terms = declustered.terms;
      ceTerms = declustered.ceTerms;
    }
    caseIntercepts = fitCaseIntercepts(points, { ...base, terms });
  }
  return {
    family,
    ...base,
    terms,
    ceTerms,
    diagnostics: joint.diagnostics,
    caseIntercepts,
    n: points.length,
    sessions,
  };
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
  /** Held-out mean absolute error per fold, so a tier gain can be tested. */
  foldErrors: { caseKey: string; n: number; mae: number }[];
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
  const foldErrors: { caseKey: string; n: number; mae: number }[] = [];
  let folds = 0;
  if (caseKeys.length >= 2) {
    for (const key of caseKeys) {
      const train = points.filter((p) => (p.sessionId ?? "unfiled") !== key);
      const test = points.filter((p) => (p.sessionId ?? "unfiled") === key);
      if (train.length < 5 || !test.length) continue;
      const model = fitCoebisModel(train, family);
      if (!model) continue;
      folds++;
      let absSum = 0;
      for (const p of test) {
        const predicted = predictCoebis(model, p, false);
        predictions.push({ predicted, bis: p.bis });
        absSum += Math.abs(predicted - p.bis);
      }
      foldErrors.push({
        caseKey: key,
        n: test.length,
        mae: Number((absSum / test.length).toFixed(3)),
      });
    }
  }
  return { family, outOfSample: agreementSummary(predictions), inSample, folds, foldErrors };
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
