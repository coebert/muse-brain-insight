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
  crossValidateByCase,
  fitCoebisModel,
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

  const cv = crossValidateByCase(points, family);
  const model = fitCoebisModel(points, family);
  const maeGain =
    before.mae != null && cv.outOfSample.mae != null
      ? round(before.mae - cv.outOfSample.mae, 3)
      : null;
  const biasChange =
    before.bias != null && cv.outOfSample.bias != null
      ? round(Math.abs(cv.outOfSample.bias) - Math.abs(before.bias), 3)
      : null;

  const base = { ...empty, sufficient: true, after: cv.outOfSample, inSample: cv.inSample, folds: cv.folds, maeGain, biasChange };

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
