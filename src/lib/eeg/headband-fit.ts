/**
 * Headband-only (provisional) COEBIS fit.
 *
 * The scheduled refit pipeline needs 30 validated readings across 3 cases
 * before it will touch a lineage. That bar is right for a model that is
 * already usable, but the headband lineage starts life tens of points away
 * from the bedside monitor, so waiting leaves the clinician reading a number
 * that is known to be wrong.
 *
 * This path fits the headband's own readings alone — never pooled with the
 * research corpora, whose montages and monitors differ — using a two-parameter
 * affine map only, which is the most that a couple of dozen readings can
 * support. It is scored leave-one-case-out exactly like the full pipeline, and
 * is only ever promoted as a *provisional* model: it must beat the raw index
 * on held-out cases, stay inside the gain guard rails, and it is superseded as
 * soon as the lineage clears the full gate.
 */

import {
  agreementSummary,
  predictCoebis,
  type CoebisModel,
  type CoebisTrainingPoint,
} from "./coebis-covariates";
import {
  GAIN_LIMITS,
  MAX_OFFSET,
  MIN_POINTS,
  MIN_SESSIONS,
  PROVISIONAL_MIN_POINTS,
  PROVISIONAL_MIN_SESSIONS,
} from "./bis-drift";
import { MIN_MAE_GAIN, type LineageRefit } from "./coebis-refit";

/** Lineage keys this provisional path is allowed to touch. */
export function isHeadbandLineage(lineageKey: string): boolean {
  const key = lineageKey.toLowerCase();
  return key.startsWith("muse") || key.startsWith("regul8");
}

export interface HeadbandFit extends LineageRefit {
  /** True while the lineage is below the full 30-reading / 3-case bar. */
  provisional: boolean;
  /** How well deep readings are flagged, held-out, before and after the fit. */
  deep?: { before: DeepDetection; after: DeepDetection; weight: number; threshold: number };
}

/** A reading at or below this monitor value is a deep reading. */
export const DEEP_BIS = 40;

/**
 * Weight applied to deep readings when fitting.
 *
 * An unweighted least-squares map is dominated by the light readings, which
 * outnumber the deep ones several to one in headband recordings; the fitted
 * line then sits too high exactly where being wrong matters. Weighting deep
 * readings up pulls the line down into the deep range at some cost in the
 * light range. Grading stays unweighted, so the trade-off is visible.
 */
export const DEEP_WEIGHT = 4;

/** Extra average error, in index points, worth paying for better deep flagging. */
export const MAX_DEEP_COST = 1.5;

export interface DeepDetection {
  /** Readings the monitor called deep. */
  monitorDeep: number;
  /** Readings the model called deep. */
  calledDeep: number;
  /** Deep readings the model also called deep. */
  hits: number;
  /** Share of the monitor's deep readings caught, 0-100. */
  sensitivity: number | null;
  /** Share of the monitor's light readings left light, 0-100. */
  specificity: number | null;
}

function deepDetection(pairs: { predicted: number; bis: number }[]): DeepDetection {
  let monitorDeep = 0;
  let calledDeep = 0;
  let hits = 0;
  let lightKept = 0;
  for (const p of pairs) {
    const truth = p.bis <= DEEP_BIS;
    const called = p.predicted <= DEEP_BIS;
    if (truth) monitorDeep++;
    if (called) calledDeep++;
    if (truth && called) hits++;
    if (!truth && !called) lightKept++;
  }
  const light = pairs.length - monitorDeep;
  return {
    monitorDeep,
    calledDeep,
    hits,
    sensitivity: monitorDeep ? Number(((hits / monitorDeep) * 100).toFixed(1)) : null,
    specificity: light ? Number(((lightKept / light) * 100).toFixed(1)) : null,
  };
}

/**
 * Weighted affine map of the headband index onto the monitor scale.
 *
 * Two parameters only — a couple of dozen readings cannot support more.
 */
function fitWeightedAffine(
  points: CoebisTrainingPoint[],
  weight: (p: CoebisTrainingPoint) => number,
): CoebisModel | null {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const w = weight(p);
    if (!Number.isFinite(p.appIndex) || !Number.isFinite(p.bis) || w <= 0) continue;
    sw += w;
    sx += w * p.appIndex;
    sy += w * p.bis;
    sxx += w * p.appIndex * p.appIndex;
    sxy += w * p.appIndex * p.bis;
  }
  if (sw <= 0) return null;
  const varX = sxx - (sx * sx) / sw;
  if (!Number.isFinite(varX) || Math.abs(varX) < 1e-9) return null;
  const gain = (sxy - (sx * sy) / sw) / varX;
  const offset = (sy - gain * sx) / sw;
  if (!Number.isFinite(gain) || !Number.isFinite(offset)) return null;
  return {
    family: "affine",
    gain,
    offset,
    knots: [],
    terms: [],
    ceTerms: [],
    diagnostics: null,
    caseIntercepts: {},
    n: points.length,
    sessions: new Set(points.map((p) => p.sessionId ?? "unfiled")).size,
  };
}

function round(v: number | null, dp = 3): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

/**
 * Fit and grade a headband-only candidate.
 *
 * `incumbent` is the model currently in force for this lineage, if any; the
 * candidate has to beat it on the same held-out cases.
 */
export function refitHeadbandLineage(
  lineageKey: string,
  points: CoebisTrainingPoint[],
  incumbent: CoebisModel | null,
  options: { deepWeight?: number } = {},
): HeadbandFit {
  const family = "affine" as const;
  const cases = new Set(points.map((p) => p.sessionId ?? "unfiled")).size;
  const digest = `${lineageKey}:${points.length}:${cases}`;
  const before = incumbent
    ? agreementSummary(
        points.map((p) => ({ predicted: predictCoebis(incumbent, p, false), bis: p.bis })),
      )
    : agreementSummary(points.map((p) => ({ predicted: p.appIndex, bis: p.bis })));
  const beforeSource: "incumbent" | "raw_index" = incumbent ? "incumbent" : "raw_index";
  const provisional = points.length < MIN_POINTS || cases < MIN_SESSIONS;

  const empty: HeadbandFit = {
    lineageKey,
    n: points.length,
    cases,
    family,
    digest,
    sufficient: false,
    before,
    beforeSource,
    after: agreementSummary([]),
    inSample: agreementSummary([]),
    folds: 0,
    maeGain: null,
    biasChange: null,
    promote: false,
    reason: "",
    model: null,
    provisional,
  };

  if (points.length < PROVISIONAL_MIN_POINTS || cases < PROVISIONAL_MIN_SESSIONS) {
    return {
      ...empty,
      reason: `A headband fit needs ${PROVISIONAL_MIN_POINTS} paired readings across ${PROVISIONAL_MIN_SESSIONS} cases; there are ${points.length} across ${cases}.`,
    };
  }

  /**
   * Leave-one-case-out on the weighted fit. Weighting is applied when fitting
   * only; every held-out reading is graded with equal weight, so the headline
   * error stays comparable with the unweighted pipeline.
   */
  const caseKeys = [...new Set(points.map((p) => p.sessionId ?? "unfiled"))];
  const beforePairs = points.map((p) => ({
    predicted: incumbent ? predictCoebis(incumbent, p, false) : p.appIndex,
    bis: p.bis,
  }));

  function gradeWeight(w: number) {
    const weight = (p: CoebisTrainingPoint) => (p.bis <= DEEP_BIS ? w : 1);
    const heldOut: { predicted: number; bis: number }[] = [];
    let folds = 0;
    for (const key of caseKeys) {
      const train = points.filter((p) => (p.sessionId ?? "unfiled") !== key);
      const test = points.filter((p) => (p.sessionId ?? "unfiled") === key);
      if (train.length < 5 || !test.length) continue;
      const foldModel = fitWeightedAffine(train, weight);
      if (!foldModel) continue;
      folds++;
      for (const p of test)
        heldOut.push({ predicted: predictCoebis(foldModel, p, false), bis: p.bis });
    }
    const model = fitWeightedAffine(points, weight);
    const safe =
      model != null &&
      model.gain >= GAIN_LIMITS[0] &&
      model.gain <= GAIN_LIMITS[1] &&
      Math.abs(model.offset) <= MAX_OFFSET * 2;
    return {
      w,
      model,
      folds,
      heldOut,
      safe,
      outOfSample: agreementSummary(heldOut),
      deep: deepDetection(heldOut),
    };
  }

  /**
   * Sweep the deep weight rather than fixing it: how much the light readings
   * can be sacrificed for the deep ones depends on how the recordings sit, and
   * a weight that pushes the fitted slope outside the safe range is no use.
   * Choose on held-out error among the safe fits, so the bias has to earn its
   * place; fall back to the unweighted fit when nothing is safe.
   */
  const swept = (options.deepWeight != null ? [options.deepWeight] : [1, 2, 3, 4, 6]).map(
    gradeWeight,
  );
  const safeRuns = swept.filter((r) => r.safe && r.outOfSample.mae != null);
  const flat = swept.find((r) => r.w === 1);
  const bestMae = Math.min(...safeRuns.map((r) => r.outOfSample.mae ?? 99));
  /**
   * Among the safe fits, prefer the one that flags the most deep readings,
   * provided its overall error stays within MAX_DEEP_COST points of the best
   * available. Missing a deep reading matters more than a point of average
   * error, but not at any price.
   */
  const affordable = safeRuns.filter((r) => (r.outOfSample.mae ?? 99) <= bestMae + MAX_DEEP_COST);
  const chosen =
    affordable.sort(
      (a, b) =>
        (b.deep.sensitivity ?? 0) - (a.deep.sensitivity ?? 0) ||
        (a.outOfSample.mae ?? 99) - (b.outOfSample.mae ?? 99),
    )[0] ??
    safeRuns.sort((a, b) => (a.outOfSample.mae ?? 99) - (b.outOfSample.mae ?? 99))[0] ??
    flat ??
    swept[0]!;

  const deepWeight = chosen.w;
  const model = chosen.model;
  const folds = chosen.folds;
  const outOfSample = chosen.outOfSample;
  const inSample = model
    ? agreementSummary(points.map((p) => ({ predicted: predictCoebis(model, p, false), bis: p.bis })))
    : agreementSummary([]);
  const cv = { outOfSample, inSample, folds };
  const deep = {
    before: deepDetection(beforePairs),
    after: chosen.deep,
    weight: deepWeight,
    threshold: DEEP_BIS,
  };
  const maeGain =
    before.mae != null && cv.outOfSample.mae != null
      ? round(before.mae - cv.outOfSample.mae, 3)
      : null;
  const biasChange =
    before.bias != null && cv.outOfSample.bias != null
      ? round(Math.abs(cv.outOfSample.bias) - Math.abs(before.bias), 3)
      : null;

  const base = { ...empty, sufficient: true, after: cv.outOfSample, inSample: cv.inSample, folds: cv.folds, maeGain, biasChange, deep };

  if (!model) return { ...base, reason: "Candidate headband fit could not be computed." };
  if (cv.folds < 2)
    return { ...base, model, reason: "Not enough cases to cross-validate the headband fit." };
  if (model.gain < GAIN_LIMITS[0] || model.gain > GAIN_LIMITS[1])
    return {
      ...base,
      model,
      reason: `Fitted slope ${model.gain.toFixed(2)} is outside the safe range ${GAIN_LIMITS[0]}–${GAIN_LIMITS[1]}; treated as a bad fit.`,
    };
  if (Math.abs(model.offset) > MAX_OFFSET * 2)
    return {
      ...base,
      model,
      reason: `Fitted shift ${model.offset.toFixed(1)} points is implausibly large; treated as a bad fit.`,
    };
  if (maeGain == null)
    return { ...base, model, reason: "No comparable held-out error to judge the fit against." };
  if (maeGain < MIN_MAE_GAIN)
    return {
      ...base,
      model,
      reason: `Held-out error improves by only ${maeGain.toFixed(2)} points (needs ${MIN_MAE_GAIN}); the headband fit is not applied.`,
    };

  return {
    ...base,
    model,
    promote: true,
    reason: `${provisional ? "Provisional headband fit" : "Headband fit"}: held-out error ${before.mae?.toFixed(2)} → ${cv.outOfSample.mae?.toFixed(2)} across ${cv.folds} cases (${points.length} paired readings). ${
      provisional
        ? `Labelled provisional until ${MIN_POINTS} readings across ${MIN_SESSIONS} cases are recorded.`
        : ""
    }`.trim(),
  };
}
