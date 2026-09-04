/**
 * A suppression model fitted separately from COEBIS, then paired with it.
 *
 * Burst suppression and anaesthetic depth are not the same measurement, and a
 * single index cannot carry both. Inside deep suppression the spectral content
 * a depth index leans on has largely gone, so the index is extrapolating; the
 * only honest reading there comes from how much of the record is flat. That is
 * a different quantity with a different ground truth — the monitor's own
 * suppression ratio — and it deserves its own fit.
 *
 * This module does three things, kept strictly apart:
 *
 *  1. **Fit** a calibration from the app's suppression detector to the
 *     monitor's suppression ratio (VitalDB SR labels). The app's detector is a
 *     flat-line counter over a rolling window; the monitor's SR is a different
 *     window with a different threshold, so the two disagree systematically
 *     even when both are working. The fit is monotone by construction, so a
 *     record with more flat time can never be scored as less suppressed.
 *  2. **Pair** the fitted suppression estimate with COEBIS: at high suppression
 *     the index is capped so it cannot report a light patient while the record
 *     is mostly flat, and the pairing is reported as a bounded correction
 *     rather than folded silently into the index.
 *  3. **Grade** both against the monitor's SR on held-out cases — as a
 *     continuous error (MAE, bias) and as a detection decision (AUC,
 *     sensitivity, specificity at the working threshold) — always before and
 *     after, so the fit has to earn its place against the raw detector.
 *
 * Nothing here fabricates a suppression number for a reading that has none,
 * and no arm mixes cases across the cross-validation split.
 */

import { rocAuc } from "./diagnosis-model";
import { ridgeFit } from "./ridge";

/** Monitor SR, %, at or above which an epoch counts as suppressed. */
export const MONITOR_SUPPRESSED_PCT = 5;

/** Readings needed before a suppression fit may be promoted. */
export const MIN_FIT_POINTS = 400;
/** Independent cases needed before a suppression fit may be promoted. */
export const MIN_FIT_CASES = 5;
/** Suppressed readings needed on the positive side before detection is graded. */
export const MIN_SUPPRESSED_POINTS = 40;

/**
 * The promotion bar, set on what matters clinically rather than on average
 * error alone. Missing recorded suppression is the dangerous failure, so a fit
 * must find materially more of it than the raw detector; in exchange it may
 * cost a little accuracy on the ordinary stretches, but only a little, and it
 * may not separate suppressed from clear readings any worse.
 */
export const MIN_SENSITIVITY_GAIN = 0.02;
/** Held-out SR points of average accuracy the detection gain may cost. */
export const MAX_MAE_COST = 0.75;
/** Held-out AUC the calibration may give up. */
export const MAX_AUC_COST = 0.02;


/**
 * How far COEBIS may be pulled down by suppression, in index points. The
 * pairing is a bounded safety correction, not a second depth model.
 */
export const MAX_INDEX_CAP_SHIFT = 25;

/** Estimated SR, %, at which the index cap starts to bite. */
export const CAP_ONSET_PCT = 20;
/** Estimated SR, %, at which the cap reaches its deepest value. */
export const CAP_FULL_PCT = 60;
/** The lowest index the cap will impose, however deep the suppression. */
export const CAP_FLOOR_INDEX = 20;

/** One paired reading: what the app detected, and what the monitor recorded. */
export interface SuppressionPoint {
  /** Case the reading came from; folds never split a case across sides. */
  caseRef: string;
  atSeconds: number;
  /** The app's own suppression ratio, %. */
  appSr: number;
  /** The monitor's suppression ratio, %. Ground truth. */
  bisSr: number;
  /** The app's depth index at the same moment, for the COEBIS pairing. */
  appIndex: number | null;
  /** The monitor's index at the same moment, used only for grading the pairing. */
  bis: number | null;
  sqi: number | null;
  reliable: boolean;
}

/**
 * Fitted coefficients. The design is deliberately small — a saturating
 * transform of the app's SR, its square root for the low tail where a few flat
 * segments already mean something, and an index term that carries the fact
 * that a very low depth index is itself evidence of suppression.
 */
export interface SuppressionModel {
  intercept: number;
  /** Coefficient on the app's suppression ratio. */
  bSr: number;
  /** Coefficient on sqrt(app SR) — sharpens the low, clinically decisive tail. */
  bSqrtSr: number;
  /** Coefficient on the depth-index deficit below 40 points. */
  bIndexDeficit: number;
  n: number;
  cases: number;
}

export interface SuppressionDesignRow {
  sr: number;
  sqrtSr: number;
  indexDeficit: number;
}

/** Index below which a low depth reading starts to count as corroboration. */
const INDEX_DEFICIT_FROM = 40;

export function designRow(appSr: number, appIndex: number | null): SuppressionDesignRow {
  const sr = clamp(appSr, 0, 100);
  const deficit =
    appIndex == null || !Number.isFinite(appIndex)
      ? 0
      : Math.max(0, INDEX_DEFICIT_FROM - clamp(appIndex, 0, 100));
  return { sr, sqrtSr: Math.sqrt(sr), indexDeficit: deficit };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Predicted monitor SR, %, for one reading. Always inside 0–100. */
export function predictSr(model: SuppressionModel, appSr: number, appIndex: number | null): number {
  const row = designRow(appSr, appIndex);
  const raw =
    model.intercept +
    model.bSr * row.sr +
    model.bSqrtSr * row.sqrtSr +
    model.bIndexDeficit * row.indexDeficit;
  return clamp(raw, 0, 100);
}

/**
 * Fit the calibration on the given readings.
 *
 * Weighting: readings the app flagged as unreliable, or with a poor signal
 * quality index, still carry information but should not set the calibration,
 * so they enter at reduced weight rather than being discarded. Suppressed
 * readings are the minority class and the clinically consequential one, so
 * they are up-weighted to stop the fit collapsing onto "never suppressed".
 */
export function fitSuppressionModel(points: SuppressionPoint[]): SuppressionModel | null {
  const usable = points.filter(
    (p) => Number.isFinite(p.appSr) && Number.isFinite(p.bisSr) && p.bisSr >= 0,
  );
  if (usable.length < 20) return null;

  const suppressed = usable.filter((p) => p.bisSr >= MONITOR_SUPPRESSED_PCT).length;
  const clear = usable.length - suppressed;
  // Suppressed readings are the minority class and the clinically
  // consequential one — a missed suppression matters far more than a fraction
  // of a percentage point of error on a clear stretch — so the two sides are
  // balanced. On the VitalDB pool this is what separates a fit that finds real
  // suppression the raw detector misses from one that simply answers "clear";
  // the price is a small rise in average error, which the promotion gate caps.
  const positiveWeight =
    suppressed > 0 ? Math.min(8, Math.max(1, clear / suppressed)) : 1;





  const x: number[][] = [];
  const y: number[] = [];
  const w: number[] = [];
  for (const p of usable) {
    const row = designRow(p.appSr, p.appIndex);
    x.push([row.sr, row.sqrtSr, row.indexDeficit]);
    y.push(clamp(p.bisSr, 0, 100));
    let weight = p.reliable ? 1 : 0.4;
    if (p.sqi != null && Number.isFinite(p.sqi)) weight *= clamp(p.sqi, 0.2, 1);
    if (p.bisSr >= MONITOR_SUPPRESSED_PCT) weight *= positiveWeight;
    w.push(weight);
  }

  const fit = ridgeFit(x, y, w, [0.5, 0.5, 1]);
  if (!fit) return null;
  const [bSr, bSqrtSr, bIndexDeficit] = fit.coefficients as [number, number, number];
  // Monotonicity guard: more flat time must never predict less suppression.
  // A negative slope here would be an artefact of collinearity between the
  // linear and square-root terms, not a finding, so the fit is rejected.
  if (!Number.isFinite(bSr) || !Number.isFinite(bSqrtSr)) return null;
  if (bSr < 0 && bSr + bSqrtSr / 20 < 0) return null;

  return {
    intercept: fit.intercept,
    bSr,
    bSqrtSr,
    bIndexDeficit: Math.max(0, bIndexDeficit),
    n: usable.length,
    cases: new Set(usable.map((p) => p.caseRef)).size,
  };
}

/** Continuous agreement of an SR estimate with the monitor's SR. */
export interface SrAgreement {
  n: number;
  cases: number;
  /** Mean absolute error, SR points. */
  mae: number | null;
  /** Mean signed error — positive means the estimate reads high. */
  bias: number | null;
  /** Pearson correlation with the monitor's SR. */
  r: number | null;
}

/** The suppressed/clear decision, graded at the working threshold. */
export interface SrDetection {
  suppressed: number;
  clear: number;
  cases: number;
  auc: number | null;
  sensitivity: number | null;
  specificity: number | null;
  /** Suppressed readings missed entirely — the failure that matters clinically. */
  missed: number;
  /** Clear readings called suppressed. */
  falseAlarms: number;
}

export interface SuppressionGrade {
  agreement: SrAgreement;
  detection: SrDetection;
}

export function gradeEstimates(
  points: SuppressionPoint[],
  estimate: (p: SuppressionPoint) => number,
): SuppressionGrade {
  const rows = points.filter((p) => Number.isFinite(p.bisSr));
  const cases = new Set(rows.map((p) => p.caseRef)).size;
  const errors: number[] = [];
  const scores: number[] = [];
  const labels: boolean[] = [];
  for (const p of rows) {
    const est = clamp(estimate(p), 0, 100);
    errors.push(est - p.bisSr);
    scores.push(est);
    labels.push(p.bisSr >= MONITOR_SUPPRESSED_PCT);
  }
  const n = rows.length;
  const mae = n ? errors.reduce((s, e) => s + Math.abs(e), 0) / n : null;
  const bias = n ? errors.reduce((s, e) => s + e, 0) / n : null;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < n; i++) {
    const positive = scores[i]! >= MONITOR_SUPPRESSED_PCT;
    if (labels[i]) positive ? tp++ : fn++;
    else positive ? fp++ : tn++;
  }

  const suppressed = tp + fn;
  const clear = fp + tn;
  return {
    agreement: {
      n,
      cases,
      mae: mae == null ? null : round(mae),
      bias: bias == null ? null : round(bias),
      r: pearson(scores, rows.map((p) => p.bisSr)),
    },
    detection: {
      suppressed,
      clear,
      cases,
      auc: suppressed && clear ? round(rocAuc(scores, labels) ?? 0, 3) : null,
      sensitivity: suppressed ? round(tp / suppressed, 3) : null,
      specificity: clear ? round(tn / clear, 3) : null,
      missed: fn,
      falseAlarms: fp,
    },
  };
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da <= 1e-9 || db <= 1e-9) return null;
  return round(num / Math.sqrt(da * db), 3);
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Cross-validated grading, folded by case so no case appears on both sides.
 *
 * "Before" is the app's raw suppression detector; "after" is the calibration
 * fitted on the other folds. If the calibration does not beat the raw detector
 * out of sample it has learned the training cases, not suppression.
 */
export interface SuppressionFitReport {
  lineage: string;
  points: number;
  cases: number;
  suppressedPoints: number;
  folds: number;
  before: SuppressionGrade;
  after: SuppressionGrade;
  /** Model refitted on everything, for use once the gate is cleared. */
  model: SuppressionModel | null;
  /** MAE points gained out of sample; negative means the fit is worse. */
  maeGain: number | null;
  /** Held-out sensitivity gained over the raw detector, 0–1. */
  sensitivityGain: number | null;

  /** Whether the fit meets the volume and improvement bar. */
  promotable: boolean;
  /** Plain-language reason when it is not promotable. */
  blockedBy: string | null;
}

export function crossValidate(
  lineage: string,
  points: SuppressionPoint[],
  maxFolds = 8,
): SuppressionFitReport {
  const usable = points.filter((p) => Number.isFinite(p.appSr) && Number.isFinite(p.bisSr));
  const caseRefs = [...new Set(usable.map((p) => p.caseRef))].sort();
  const suppressedPoints = usable.filter((p) => p.bisSr >= MONITOR_SUPPRESSED_PCT).length;
  const folds = Math.min(maxFolds, caseRefs.length);

  const heldOutAfter: { point: SuppressionPoint; estimate: number }[] = [];
  for (let f = 0; f < folds; f++) {
    const testCases = new Set(caseRefs.filter((_, i) => i % folds === f));
    const train = usable.filter((p) => !testCases.has(p.caseRef));
    const test = usable.filter((p) => testCases.has(p.caseRef));
    if (!test.length || train.length < 20) continue;
    const model = fitSuppressionModel(train);
    if (!model) continue;
    for (const p of test) {
      heldOutAfter.push({ point: p, estimate: predictSr(model, p.appSr, p.appIndex) });
    }
  }

  const estimates = new Map(heldOutAfter.map((h) => [h.point, h.estimate]));
  const graded = heldOutAfter.map((h) => h.point);
  const before = gradeEstimates(graded, (p) => p.appSr);
  const after = gradeEstimates(graded, (p) => estimates.get(p) ?? p.appSr);
  const model = fitSuppressionModel(usable);

  const maeGain =
    before.agreement.mae != null && after.agreement.mae != null
      ? round(before.agreement.mae - after.agreement.mae)
      : null;
  const sensitivityGain =
    before.detection.sensitivity != null && after.detection.sensitivity != null
      ? round(after.detection.sensitivity - before.detection.sensitivity, 3)
      : null;
  const aucChange =
    before.detection.auc != null && after.detection.auc != null
      ? round(after.detection.auc - before.detection.auc, 3)
      : null;

  let blockedBy: string | null = null;
  if (usable.length < MIN_FIT_POINTS) {
    blockedBy = `${usable.length.toLocaleString()} of ${MIN_FIT_POINTS.toLocaleString()} paired readings`;
  } else if (caseRefs.length < MIN_FIT_CASES) {
    blockedBy = `${caseRefs.length} of ${MIN_FIT_CASES} cases`;
  } else if (suppressedPoints < MIN_SUPPRESSED_POINTS) {
    blockedBy = `${suppressedPoints} of ${MIN_SUPPRESSED_POINTS} readings with recorded suppression`;
  } else if (!model) {
    blockedBy = "the fit did not converge on a usable calibration";
  } else if (sensitivityGain == null || sensitivityGain < MIN_SENSITIVITY_GAIN) {
    blockedBy = "the calibration finds no more recorded suppression than the raw detector";
  } else if (aucChange != null && aucChange < -MAX_AUC_COST) {
    blockedBy = "the calibration separates suppressed from clear readings worse than the raw detector";
  } else if (maeGain == null || maeGain < -MAX_MAE_COST) {
    blockedBy = `the extra suppression it finds costs more than ${MAX_MAE_COST} SR points of accuracy elsewhere`;
  }


  return {
    lineage,
    points: usable.length,
    cases: caseRefs.length,
    suppressedPoints,
    folds,
    before,
    after,
    model,
    maeGain,
    sensitivityGain,
    promotable: blockedBy === null,
    blockedBy,
  };
}

/**
 * Pair the suppression estimate with COEBIS.
 *
 * The cap is one-sided and bounded: it can only pull the index down, never up,
 * by at most {@link MAX_INDEX_CAP_SHIFT} points, and never below
 * {@link CAP_FLOOR_INDEX}. Below {@link CAP_ONSET_PCT} estimated SR nothing
 * happens at all. The point is to stop the index reporting a light patient
 * while the record is largely flat — not to become a second depth model.
 */
export interface PairedReading {
  /** COEBIS as it stands. */
  index: number;
  /** Estimated monitor SR from the suppression model. */
  estimatedSr: number;
  /** The index after the suppression cap. */
  cappedIndex: number;
  /** Points removed; zero when the cap did not engage. */
  shift: number;
  engaged: boolean;
}

export function pairWithCoebis(index: number, estimatedSr: number): PairedReading {
  const sr = clamp(estimatedSr, 0, 100);
  const idx = clamp(index, 0, 100);
  if (sr < CAP_ONSET_PCT) {
    return { index: idx, estimatedSr: sr, cappedIndex: idx, shift: 0, engaged: false };
  }
  const depth = Math.min(1, (sr - CAP_ONSET_PCT) / (CAP_FULL_PCT - CAP_ONSET_PCT));
  const ceiling = Math.max(CAP_FLOOR_INDEX, idx - MAX_INDEX_CAP_SHIFT * depth);
  const capped = Math.min(idx, ceiling);
  return {
    index: idx,
    estimatedSr: sr,
    cappedIndex: round(capped),
    shift: round(idx - capped),
    engaged: capped < idx - 0.05,
  };
}

/** How the pairing changes COEBIS's agreement with the monitor's index. */
export interface PairingGrade {
  /** Readings where the cap engaged. */
  engaged: number;
  cases: number;
  /** COEBIS mean absolute error against the monitor index, before the cap. */
  maeBefore: number | null;
  maeAfter: number | null;
  /** Positive means the pairing moved COEBIS closer to the monitor. */
  gain: number | null;
  /** Readings inside recorded suppression that COEBIS read as light (>60). */
  falselyLightBefore: number;
  falselyLightAfter: number;
}

/** Index above which a reading inside recorded suppression is plainly wrong. */
const FALSELY_LIGHT_INDEX = 60;

export function gradePairing(
  points: SuppressionPoint[],
  model: SuppressionModel | null,
): PairingGrade {
  const rows = points.filter(
    (p) => p.appIndex != null && p.bis != null && Number.isFinite(p.bisSr),
  );
  let engaged = 0;
  let sumBefore = 0;
  let sumAfter = 0;
  let falselyLightBefore = 0;
  let falselyLightAfter = 0;
  for (const p of rows) {
    const estimated = model ? predictSr(model, p.appSr, p.appIndex) : p.appSr;
    const paired = pairWithCoebis(p.appIndex!, estimated);
    if (paired.engaged) engaged++;
    sumBefore += Math.abs(p.appIndex! - p.bis!);
    sumAfter += Math.abs(paired.cappedIndex - p.bis!);
    if (p.bisSr >= MONITOR_SUPPRESSED_PCT) {
      if (p.appIndex! > FALSELY_LIGHT_INDEX) falselyLightBefore++;
      if (paired.cappedIndex > FALSELY_LIGHT_INDEX) falselyLightAfter++;
    }
  }
  const n = rows.length;
  const maeBefore = n ? round(sumBefore / n) : null;
  const maeAfter = n ? round(sumAfter / n) : null;
  return {
    engaged,
    cases: new Set(rows.map((p) => p.caseRef)).size,
    maeBefore,
    maeAfter,
    gain: maeBefore != null && maeAfter != null ? round(maeBefore - maeAfter) : null,
    falselyLightBefore,
    falselyLightAfter,
  };
}

/** Everything the page shows for one acquisition lineage. */
export interface SuppressionReport {
  fit: SuppressionFitReport;
  pairing: PairingGrade;
  /** Cases ranked by how badly the raw detector disagreed with the monitor. */
  worstCases: CaseDisagreement[];
}

export interface CaseDisagreement {
  caseRef: string;
  points: number;
  suppressedPoints: number;
  meanAppSr: number;
  meanMonitorSr: number;
  maeBefore: number;
  maeAfter: number | null;
}

export function caseDisagreements(
  points: SuppressionPoint[],
  model: SuppressionModel | null,
  limit = 10,
): CaseDisagreement[] {
  const byCase = new Map<string, SuppressionPoint[]>();
  for (const p of points) {
    const list = byCase.get(p.caseRef);
    if (list) list.push(p);
    else byCase.set(p.caseRef, [p]);
  }
  const out: CaseDisagreement[] = [];
  for (const [caseRef, rows] of byCase) {
    const n = rows.length;
    if (!n) continue;
    const meanAppSr = rows.reduce((s, p) => s + p.appSr, 0) / n;
    const meanMonitorSr = rows.reduce((s, p) => s + p.bisSr, 0) / n;
    const maeBefore = rows.reduce((s, p) => s + Math.abs(p.appSr - p.bisSr), 0) / n;
    const maeAfter = model
      ? rows.reduce(
          (s, p) => s + Math.abs(predictSr(model, p.appSr, p.appIndex) - p.bisSr),
          0,
        ) / n
      : null;
    out.push({
      caseRef,
      points: n,
      suppressedPoints: rows.filter((p) => p.bisSr >= MONITOR_SUPPRESSED_PCT).length,
      meanAppSr: round(meanAppSr),
      meanMonitorSr: round(meanMonitorSr),
      maeBefore: round(maeBefore),
      maeAfter: maeAfter == null ? null : round(maeAfter),
    });
  }
  return out.sort((a, b) => b.maeBefore - a.maeBefore).slice(0, limit);
}

export function emptyReport(lineage = "vitaldb"): SuppressionReport {
  const emptyGrade: SuppressionGrade = {
    agreement: { n: 0, cases: 0, mae: null, bias: null, r: null },
    detection: {
      suppressed: 0,
      clear: 0,
      cases: 0,
      auc: null,
      sensitivity: null,
      specificity: null,
      missed: 0,
      falseAlarms: 0,
    },
  };
  return {
    fit: {
      lineage,
      points: 0,
      cases: 0,
      suppressedPoints: 0,
      folds: 0,
      before: emptyGrade,
      after: emptyGrade,
      model: null,
      maeGain: null,
      sensitivityGain: null,
      promotable: false,
      blockedBy: "no paired suppression readings loaded",
    },
    pairing: {
      engaged: 0,
      cases: 0,
      maeBefore: null,
      maeAfter: null,
      gain: null,
      falselyLightBefore: 0,
      falselyLightAfter: 0,
    },
    worstCases: [],
  };
}
