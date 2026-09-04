/**
 * Per-case view of the ketamine stage.
 *
 * The correction in `ketamine.ts` acts epoch by epoch and only when ketamine is
 * *declared*. This module rolls those epochs up per case so it is visible, at a
 * glance, which recordings the subtraction is actually moving, which ones only
 * carry the spectral pattern (advisory, no correction), and whether the case has
 * enough independently recorded suppression / depth-state labels for that
 * movement to be graded rather than merely asserted.
 *
 * Nothing here infers ketamine from the EEG: `declared` always comes from the
 * case record (regimen, drug entry, marker), exactly as the correction does.
 */

import {
  ketamineCorrection,
  ketamineScore,
  type KetamineFeatures,
  type KetamineSignature,
} from "./ketamine";
import type { DepthStateLabel, SuppressionLabel } from "./pathology-labels";
import type { KetamineGradingReport } from "./ketamine-grading";

/** Index at or below which an epoch reads as anaesthetised (from the DOSE-I / ds004541 grading). */
export const ANAESTHESIA_THRESHOLD = 83;
/** Pattern strength at which an undeclared case is worth flagging. */
export const PATTERN_POSITIVE = 0.4;
/** App suppression ratio (%) at which the app itself calls an epoch suppressed. */
export const APP_SUPPRESSED_PCT = 5;
/** Fewest labelled epochs before a per-case grade is reported rather than withheld. */
export const MIN_GRADED_EPOCHS = 20;
/** Fewest epochs per state arm before a depth-state separation is reported. */
export const MIN_STATE_ARM = 10;

/** One analysed epoch belonging to a case, as the loader hands it over. */
export interface KetamineCaseEpoch {
  lineage: string;
  caseRef: string;
  atSeconds: number;
  features: KetamineFeatures;
  /** COEBIS (or the app depth index) at this moment, before the ketamine stage. */
  coebis: number | null;
  /** App-measured suppression ratio, percent. */
  suppressionPct: number | null;
  /** Independently recorded suppression status, if any. */
  suppressionLabel: SuppressionLabel | null;
  /** Independently recorded anaesthetic state, if any. */
  stateLabel: DepthStateLabel | null;
  /** Ketamine recorded for the case in the source record. */
  declared: boolean;
}

/** What the ketamine stage is doing to a case. */
export type KetamineEffect =
  /** Declared, pattern present, index actually moved. */
  | "correcting"
  /** Declared, but nothing to correct in the epochs seen. */
  | "watched"
  /** Pattern present, ketamine not recorded — advisory only, no movement. */
  | "advisory"
  /** Neither declared nor patterned. */
  | "quiet";

export type Grade = "agrees" | "disagrees" | "separates" | "overlaps" | "insufficient";

export interface SuppressionGrade {
  /** Epochs carrying an independent suppression label. */
  labelled: number;
  /** Of those, how many were labelled suppressed. */
  suppressed: number;
  /** Mean app-measured suppression ratio over the labelled epochs, percent. */
  appMeanSr: number | null;
  /** Fraction of labelled epochs where the app agrees with the label. */
  concordance: number | null;
  grade: Extract<Grade, "agrees" | "disagrees" | "insufficient">;
}

export interface StateGrade {
  anaesthetised: number;
  awake: number;
  meanAnaesthetised: number | null;
  meanAwake: number | null;
  /** Mean awake index minus mean anaesthetised index, in points. */
  separation: number | null;
  grade: Extract<Grade, "separates" | "overlaps" | "insufficient">;
}

export interface KetamineCaseSummary {
  lineage: string;
  caseRef: string;
  epochs: number;
  declared: boolean;
  effect: KetamineEffect;
  /** Mean 13–47 Hz share of the spectrum, 0–1. */
  meanBetaGamma: number | null;
  maxBetaGamma: number | null;
  meanAlpha: number | null;
  meanSlow: number | null;
  meanScore: number;
  maxScore: number;
  /** Fraction of epochs whose pattern strength clears PATTERN_POSITIVE. */
  patternFraction: number;
  /** Epochs where the correction actually removed points. */
  correctedEpochs: number;
  /** Mean correction over corrected epochs, in points (<= 0). */
  meanDelta: number | null;
  maxDelta: number | null;
  /**
   * Epochs the correction carries across the anaesthesia threshold — the ones
   * where the subtraction changes the clinical reading, not just the number.
   */
  crossings: number;
  suppression: SuppressionGrade;
  state: StateGrade;
}

export interface KetamineCaseReport {
  cases: KetamineCaseSummary[];
  /** Before/after grading of the subtraction against the recorded labels. */
  grading: KetamineGradingReport;
  /** Epochs read out of the database, before per-case thinning. */
  scanned: number;
  totals: {
    cases: number;
    declaredCases: number;
    correctingCases: number;
    advisoryCases: number;
    correctedEpochs: number;
    crossings: number;
  };
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3));
}

/** Ketamine signature for a single epoch, with the declaration honoured. */
export function epochSignature(epoch: KetamineCaseEpoch): KetamineSignature {
  return ketamineCorrection({
    aligned: epoch.coebis,
    features: epoch.features,
    exposure: epoch.declared ? "declared" : "none",
    bsr: epoch.suppressionPct ?? 0,
  });
}

function suppressionGrade(epochs: KetamineCaseEpoch[]): SuppressionGrade {
  const labelled = epochs.filter((e) => e.suppressionLabel != null);
  const withApp = labelled.filter((e) => e.suppressionPct != null);
  const suppressed = labelled.filter((e) => e.suppressionLabel === "suppressed").length;
  const appMeanSr = mean(withApp.map((e) => e.suppressionPct as number));
  const agree = withApp.filter(
    (e) =>
      (e.suppressionPct as number) >= APP_SUPPRESSED_PCT ===
      (e.suppressionLabel === "suppressed"),
  ).length;
  const concordance = withApp.length ? Number((agree / withApp.length).toFixed(3)) : null;
  const grade =
    withApp.length < MIN_GRADED_EPOCHS || concordance == null
      ? "insufficient"
      : concordance >= 0.8
        ? "agrees"
        : "disagrees";
  return { labelled: labelled.length, suppressed, appMeanSr, concordance, grade };
}

function stateGrade(epochs: KetamineCaseEpoch[]): StateGrade {
  const arm = (label: DepthStateLabel) =>
    epochs.filter((e) => e.stateLabel === label && e.coebis != null).map((e) => e.coebis as number);
  const anaes = arm("anaesthetised");
  const awake = arm("awake");
  const meanAnaesthetised = mean(anaes);
  const meanAwake = mean(awake);
  const separation =
    meanAnaesthetised != null && meanAwake != null
      ? Number((meanAwake - meanAnaesthetised).toFixed(2))
      : null;
  const grade =
    anaes.length < MIN_STATE_ARM || awake.length < MIN_STATE_ARM || separation == null
      ? "insufficient"
      : separation >= 10
        ? "separates"
        : "overlaps";
  return {
    anaesthetised: anaes.length,
    awake: awake.length,
    meanAnaesthetised,
    meanAwake,
    separation,
    grade,
  };
}

/** Roll a case's epochs up into one row of the ketamine dashboard. */
export function summariseCase(caseEpochs: KetamineCaseEpoch[]): KetamineCaseSummary {
  const first = caseEpochs[0]!;
  const declared = caseEpochs.some((e) => e.declared);
  const betaGamma: number[] = [];
  const alphas: number[] = [];
  const slows: number[] = [];
  const scores: number[] = [];
  const deltas: number[] = [];
  let patternPositive = 0;
  let crossings = 0;

  for (const epoch of caseEpochs) {
    const { score, betaGamma: bg } = ketamineScore(epoch.features);
    scores.push(score);
    if (bg != null) betaGamma.push(bg);
    if (epoch.features.alphaFraction != null) alphas.push(epoch.features.alphaFraction);
    if (epoch.features.slowFraction != null) slows.push(epoch.features.slowFraction);
    if (score >= PATTERN_POSITIVE) patternPositive += 1;

    const signature = epochSignature(epoch);
    if (signature.corrected && signature.delta < 0) {
      deltas.push(signature.delta);
      if (
        epoch.coebis != null &&
        epoch.coebis > ANAESTHESIA_THRESHOLD &&
        epoch.coebis + signature.delta <= ANAESTHESIA_THRESHOLD
      ) {
        crossings += 1;
      }
    }
  }

  const maxScore = scores.length ? Math.max(...scores) : 0;
  const patternFraction = caseEpochs.length
    ? Number((patternPositive / caseEpochs.length).toFixed(3))
    : 0;
  const effect: KetamineEffect = declared
    ? deltas.length
      ? "correcting"
      : "watched"
    : maxScore >= PATTERN_POSITIVE
      ? "advisory"
      : "quiet";

  return {
    lineage: first.lineage,
    caseRef: first.caseRef,
    epochs: caseEpochs.length,
    declared,
    effect,
    meanBetaGamma: mean(betaGamma),
    maxBetaGamma: betaGamma.length ? Number(Math.max(...betaGamma).toFixed(3)) : null,
    meanAlpha: mean(alphas),
    meanSlow: mean(slows),
    meanScore: mean(scores) ?? 0,
    maxScore: Number(maxScore.toFixed(3)),
    patternFraction,
    correctedEpochs: deltas.length,
    meanDelta: mean(deltas),
    maxDelta: deltas.length ? Number(Math.min(...deltas).toFixed(2)) : null,
    crossings,
    suppression: suppressionGrade(caseEpochs),
    state: stateGrade(caseEpochs),
  };
}

/** Build the whole per-case report, most affected cases first. */
export function summariseKetamineCases(
  epochs: KetamineCaseEpoch[],
  scanned = epochs.length,
  /** Grading is computed by the caller so this module stays free of a cycle. */
  grading: KetamineGradingReport = { arms: [], declaredCases: 0, patternedCases: 0, notes: [] },
): KetamineCaseReport {
  const byCase = new Map<string, KetamineCaseEpoch[]>();
  for (const epoch of epochs) {
    const key = `${epoch.lineage}/${epoch.caseRef}`;
    const list = byCase.get(key) ?? [];
    list.push(epoch);
    byCase.set(key, list);
  }

  const order: Record<KetamineEffect, number> = {
    correcting: 0,
    advisory: 1,
    watched: 2,
    quiet: 3,
  };
  const cases = [...byCase.values()]
    .map(summariseCase)
    .sort(
      (a, b) =>
        order[a.effect] - order[b.effect] ||
        b.crossings - a.crossings ||
        b.maxScore - a.maxScore ||
        a.caseRef.localeCompare(b.caseRef),
    );

  return {
    cases,
    grading,
    scanned,
    totals: {
      cases: cases.length,
      declaredCases: cases.filter((c) => c.declared).length,
      correctingCases: cases.filter((c) => c.effect === "correcting").length,
      advisoryCases: cases.filter((c) => c.effect === "advisory").length,
      correctedEpochs: cases.reduce((a, c) => a + c.correctedEpochs, 0),
      crossings: cases.reduce((a, c) => a + c.crossings, 0),
    },
  };
}

/** Ketamine features from stored band powers (delta/theta/alpha/beta/gamma). */
export function featuresFromBands(bands: Record<string, unknown> | null): KetamineFeatures {
  const value = (key: string): number | null => {
    const n = Number(bands?.[key]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const delta = value("delta");
  const theta = value("theta");
  const alpha = value("alpha");
  const beta = value("beta");
  const gamma = value("gamma");
  const total = [delta, theta, alpha, beta, gamma].reduce<number>((a, b) => a + (b ?? 0), 0);
  if (!(total > 0) || beta == null || gamma == null) {
    return { betaFraction: null, gammaFraction: null, alphaFraction: null, slowFraction: null };
  }
  return {
    betaFraction: beta / total,
    gammaFraction: gamma / total,
    alphaFraction: alpha == null ? null : alpha / total,
    slowFraction: delta == null ? null : delta / total,
  };
}
