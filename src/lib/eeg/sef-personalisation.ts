/**
 * Personalised spectral-edge correction.
 *
 * The pooled SEF alignment (see `sef-drift.ts`) learns one straight line for
 * every case: monitor SEF ≈ gain × headband SEF + offset. That removes the
 * systematic montage/bandwidth offset of the headband but ignores the fact
 * that the size of that offset differs with the patient — an elderly brain on
 * a volatile agent does not sit on the same edge-frequency scale as a young
 * patient on propofol/remifentanil, and chronic neurological disease shifts it
 * again.
 *
 * This module layers a small, heavily shrunk set of covariate corrections and,
 * where the same anonymised patient has been recorded before, a per-patient
 * longitudinal offset on top of the pooled line:
 *
 *   monitor SEF ≈ gain × raw + offset + Σ dy(covariate level) + dy(patient)
 *
 * Safety rules that are not negotiable here:
 *   - Every term is shrunk toward zero and hard-capped, so personalisation can
 *     nudge the displayed edge frequency but never redefine it.
 *   - The model is only ever activated when it beats the pooled line
 *     *out of sample*, measured with grouped cross-validation where the groups
 *     are anonymised patients. Holding out whole patients is what prevents
 *     cross-patient leakage: repeated readings from one patient can no longer
 *     appear in both the training and the test half of a fold and flatter the
 *     model.
 *   - A patient's own longitudinal offset is applied only to that patient and
 *     is never used when scoring a held-out patient.
 */

import type { CaseCovariates } from "./covariates";
import { SEF_RANGE } from "./sef-drift";

/** One paired SEF reading with everything needed to personalise it. */
export interface SefPersonalPoint {
  /** Raw headband SEF95 in Hz. */
  appSef: number;
  /** SEF in Hz transcribed from the commercial monitor. */
  monitorSef: number;
  /** Stable anonymised patient key — patient link when known, else the case. */
  patientKey: string;
  sessionId: string | null;
  reliable: boolean;
  recordedAt: string;
  covariates: CaseCovariates;
}

/** One learned residual correction, in Hz. */
export interface SefTerm {
  group: string;
  level: string;
  /** Hz added when the case matches this level. */
  dy: number;
  n: number;
  patients: number;
}

export interface SefCvMetrics {
  folds: number;
  patients: number;
  /** Out-of-sample mean absolute error, uncorrected headband SEF. */
  maeRaw: number;
  /** Out-of-sample MAE with the pooled line only. */
  maePooled: number;
  /** Out-of-sample MAE with the pooled line plus covariate terms. */
  maePersonal: number;
  /** Out-of-sample mean signed error of the personalised model. */
  biasPersonal: number;
}

export interface SefPersonalModel {
  gain: number;
  offset: number;
  terms: SefTerm[];
  /** Longitudinal offsets keyed by anonymised patient. */
  patientOffsets: Record<string, number>;
  n: number;
  sessions: number;
  patients: number;
  cv: SefCvMetrics;
  fittedAt?: string;
  id?: string;
  provisional?: boolean;
}

/** Covariate families personalisation is allowed to use. */
const GROUPS: { group: string; pick: (c: CaseCovariates) => string | null | undefined }[] = [
  { group: "age", pick: (c) => c.ageBand },
  { group: "sex", pick: (c) => c.sex },
  { group: "regimen", pick: (c) => c.regimen },
  { group: "chronic_cns", pick: (c) => c.chronicCns },
  { group: "acute", pick: (c) => c.acuteClass },
];

/** Evidence bars. Personalisation is deliberately expensive to switch on. */
export const SEF_PERSONAL_MIN_POINTS = 24;
export const SEF_PERSONAL_MIN_SESSIONS = 3;
export const SEF_PERSONAL_MIN_PATIENTS = 4;
/** A covariate level must be seen this often, across this many patients. */
const TERM_MIN_POINTS = 6;
const TERM_MIN_PATIENTS = 2;
/** Shrinkage denominators: a small cell only moves part of the way. */
const TERM_SHRINK_K = 8;
const PATIENT_SHRINK_K = 6;
/** Hard caps, in Hz. */
const TERM_CAP = 2;
const PATIENT_CAP = 1.5;
/** A patient needs this many of their own readings before a personal offset. */
const PATIENT_MIN_POINTS = 4;
const GAIN_LIMITS: [number, number] = [0.6, 1.6];
const MAX_OFFSET = 8;
/** Out-of-sample improvement required over the pooled line, and over raw. */
const MIN_GAIN_OVER_POOLED = 0.15;
const MIN_GAIN_OVER_RAW = 0.2;
const CV_FOLDS = 5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (v: number, dp = 3) => Number(v.toFixed(dp));

/** Least-squares line, shrunk toward the identity map. */
function fitLine(points: SefPersonalPoint[]): { gain: number; offset: number } {
  if (points.length < 5) return { gain: 1, offset: 0 };
  const xs = points.map((p) => p.appSef);
  const ys = points.map((p) => p.monitorSef);
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const rawGain = sxx < 1e-6 ? 1 : sxy / sxx;
  const rawOffset = sxx < 1e-6 ? my - mx : my - rawGain * mx;
  const lambda = points.length / (points.length + 20);
  return {
    gain: clamp(1 + lambda * (rawGain - 1), GAIN_LIMITS[0], GAIN_LIMITS[1]),
    offset: clamp(lambda * rawOffset, -MAX_OFFSET, MAX_OFFSET),
  };
}

/**
 * Per-patient weighting. A single patient with 40 readings must not be able to
 * define a covariate term on their own, so each reading carries 1/n of its
 * patient's weight within the cell.
 */
function weightedResidual(rows: { residual: number; patientKey: string }[]): {
  dy: number;
  patients: number;
} {
  const byPatient = new Map<string, number[]>();
  for (const r of rows) {
    const list = byPatient.get(r.patientKey);
    if (list) list.push(r.residual);
    else byPatient.set(r.patientKey, [r.residual]);
  }
  const perPatient = [...byPatient.values()].map((rs) => mean(rs));
  return { dy: mean(perPatient), patients: byPatient.size };
}

/** Covariate residual terms on top of an already-fitted line. */
function fitTerms(
  points: SefPersonalPoint[],
  line: { gain: number; offset: number },
): SefTerm[] {
  const terms: SefTerm[] = [];
  // Groups are fitted sequentially against the residual left by the groups
  // already fitted. Covariates are correlated in practice (age with frailty,
  // regimen with pathology), and fitting each one against the same raw
  // residual would double-count the same shift.
  for (const { group, pick } of GROUPS) {
    const cells = new Map<string, { residual: number; patientKey: string }[]>();
    for (const p of points) {
      const level = pick(p.covariates);
      if (!level) continue;
      const residual =
        p.monitorSef -
        (line.gain * p.appSef + line.offset + sefCovariateAdjustment(terms, p.covariates));
      const cell = cells.get(level);
      if (cell) cell.push({ residual, patientKey: p.patientKey });
      else cells.set(level, [{ residual, patientKey: p.patientKey }]);
    }
    for (const [level, rows] of cells) {
      if (rows.length < TERM_MIN_POINTS) continue;
      const { dy, patients } = weightedResidual(rows);
      if (patients < TERM_MIN_PATIENTS) continue;
      const shrunk = (dy * rows.length) / (rows.length + TERM_SHRINK_K);
      const capped = clamp(shrunk, -TERM_CAP, TERM_CAP);
      if (Math.abs(capped) < 0.05) continue;
      terms.push({ group, level, dy: round(capped), n: rows.length, patients });
    }
  }
  return terms;
}

/** Sum of the covariate corrections that apply to one case. */
export function sefCovariateAdjustment(
  terms: SefTerm[],
  covariates: CaseCovariates | null | undefined,
): number {
  if (!covariates || !terms.length) return 0;
  let dy = 0;
  for (const { group, pick } of GROUPS) {
    const level = pick(covariates);
    if (!level) continue;
    const term = terms.find((t) => t.group === group && t.level === level);
    if (term) dy += term.dy;
  }
  // Even stacked, the covariate layer stays a nudge.
  return clamp(dy, -TERM_CAP * 1.5, TERM_CAP * 1.5);
}

/** Per-patient longitudinal offsets, fitted after the covariate layer. */
function fitPatientOffsets(
  points: SefPersonalPoint[],
  line: { gain: number; offset: number },
  terms: SefTerm[],
): Record<string, number> {
  const byPatient = new Map<string, number[]>();
  for (const p of points) {
    const predicted =
      line.gain * p.appSef + line.offset + sefCovariateAdjustment(terms, p.covariates);
    const list = byPatient.get(p.patientKey);
    if (list) list.push(p.monitorSef - predicted);
    else byPatient.set(p.patientKey, [p.monitorSef - predicted]);
  }
  const out: Record<string, number> = {};
  for (const [key, residuals] of byPatient) {
    if (residuals.length < PATIENT_MIN_POINTS) continue;
    const shrunk =
      (mean(residuals) * residuals.length) / (residuals.length + PATIENT_SHRINK_K);
    const capped = clamp(shrunk, -PATIENT_CAP, PATIENT_CAP);
    if (Math.abs(capped) < 0.05) continue;
    out[key] = round(capped);
  }
  return out;
}

/** Deterministic assignment of patients to folds, so refits are reproducible. */
function foldOf(key: string, folds: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % folds;
}

/**
 * Grouped cross-validation by anonymised patient. Whole patients are held out,
 * never individual readings, so nothing a patient contributed can leak into
 * the score for that patient.
 */
function crossValidate(points: SefPersonalPoint[]): SefCvMetrics | null {
  const patients = [...new Set(points.map((p) => p.patientKey))];
  if (patients.length < 2) return null;
  const folds = Math.min(CV_FOLDS, patients.length);
  const errRaw: number[] = [];
  const errPooled: number[] = [];
  const errPersonal: number[] = [];
  const signedPersonal: number[] = [];
  let used = 0;

  for (let f = 0; f < folds; f++) {
    const test = points.filter((p) => foldOf(p.patientKey, folds) === f);
    const train = points.filter((p) => foldOf(p.patientKey, folds) !== f);
    if (!test.length || train.length < 8) continue;
    used++;
    const line = fitLine(train);
    const terms = fitTerms(train, line);
    for (const p of test) {
      // No patient offset here: this patient is unseen by construction.
      const personal =
        line.gain * p.appSef + line.offset + sefCovariateAdjustment(terms, p.covariates);
      const pooled = line.gain * p.appSef + line.offset;
      errRaw.push(Math.abs(p.appSef - p.monitorSef));
      errPooled.push(Math.abs(pooled - p.monitorSef));
      errPersonal.push(Math.abs(personal - p.monitorSef));
      signedPersonal.push(personal - p.monitorSef);
    }
  }
  if (used < 2 || errPersonal.length < 8) return null;
  return {
    folds: used,
    patients: patients.length,
    maeRaw: round(mean(errRaw), 3),
    maePooled: round(mean(errPooled), 3),
    maePersonal: round(mean(errPersonal), 3),
    biasPersonal: round(mean(signedPersonal), 3),
  };
}

/** Fit the personalised model. Returns null when there is not enough evidence. */
export function fitSefPersonalModel(points: SefPersonalPoint[]): SefPersonalModel | null {
  const usable = points.filter(
    (p) =>
      Number.isFinite(p.appSef) &&
      Number.isFinite(p.monitorSef) &&
      p.appSef > 0 &&
      p.monitorSef > 0,
  );
  if (usable.length < SEF_PERSONAL_MIN_POINTS) return null;
  const reliable = usable.filter((p) => p.reliable);
  const fitSet = reliable.length >= SEF_PERSONAL_MIN_POINTS ? reliable : usable;

  const patients = new Set(fitSet.map((p) => p.patientKey));
  const sessions = new Set(fitSet.map((p) => p.sessionId ?? "unfiled"));
  if (patients.size < SEF_PERSONAL_MIN_PATIENTS) return null;
  if (sessions.size < SEF_PERSONAL_MIN_SESSIONS) return null;

  const cv = crossValidate(fitSet);
  if (!cv) return null;

  const line = fitLine(fitSet);
  const terms = fitTerms(fitSet, line);
  if (!terms.length) return null;

  return {
    gain: round(line.gain, 4),
    offset: round(line.offset, 3),
    terms,
    patientOffsets: fitPatientOffsets(fitSet, line, terms),
    n: fitSet.length,
    sessions: sessions.size,
    patients: patients.size,
    cv,
  };
}

/**
 * Strict gate. The personalised model replaces the pooled line only when it is
 * physiologically sane and demonstrably better on patients it has never seen.
 */
export function sefPersonalModelIsSafe(model: SefPersonalModel | null): boolean {
  if (!model) return false;
  if (model.gain < GAIN_LIMITS[0] || model.gain > GAIN_LIMITS[1]) return false;
  if (Math.abs(model.offset) > MAX_OFFSET) return false;
  if (model.terms.some((t) => Math.abs(t.dy) > TERM_CAP + 1e-6)) return false;
  if (Object.values(model.patientOffsets).some((v) => Math.abs(v) > PATIENT_CAP + 1e-6))
    return false;
  if (model.n < SEF_PERSONAL_MIN_POINTS) return false;
  if (model.patients < SEF_PERSONAL_MIN_PATIENTS) return false;
  if (model.sessions < SEF_PERSONAL_MIN_SESSIONS) return false;
  const { cv } = model;
  if (cv.maePersonal > cv.maePooled - MIN_GAIN_OVER_POOLED) return false;
  if (cv.maePersonal > cv.maeRaw - MIN_GAIN_OVER_RAW) return false;
  return true;
}

/** Plain-language description for the panel. */
export function describeSefPersonalModel(model: SefPersonalModel | null): string {
  if (!model)
    return "SEF personalisation is off: the pooled correction is in force until enough paired readings across enough separate anonymised patients show that age, sex, regimen or pathology terms improve agreement on patients the model has not seen.";
  const { cv } = model;
  return `Personalised SEF active: ${model.terms.length} covariate term${
    model.terms.length === 1 ? "" : "s"
  } fitted from ${model.n} paired readings across ${model.patients} anonymised patients. Held-out error ${cv.maePersonal.toFixed(
    2,
  )} Hz vs ${cv.maePooled.toFixed(2)} Hz pooled and ${cv.maeRaw.toFixed(
    2,
  )} Hz uncorrected, cross-validated by patient so no patient contributes to their own score.`;
}

/* ------------------------------------------------------------------ *
 * Runtime state: the model in force and the case currently on screen.
 * ------------------------------------------------------------------ */

let activeModel: SefPersonalModel | null = null;
let activePatientKey: string | null = null;

export function getActiveSefPersonalModel(): SefPersonalModel | null {
  return activeModel;
}

export function setActiveSefPersonalModel(model: SefPersonalModel | null) {
  activeModel = model;
}

/**
 * The anonymised patient the running case belongs to. Only set when the case
 * is linked to a stored patient pseudonym; without it no longitudinal offset
 * is applied, which is the safe default.
 */
export function setActiveSefPatientKey(key: string | null) {
  activePatientKey = key;
}

export function getActiveSefPatientKey(): string | null {
  return activePatientKey;
}

/**
 * Apply the personalised map to a raw headband SEF. Falls back to the caller's
 * pooled result when personalisation is off.
 */
export function applySefPersonalModel(
  rawHz: number,
  covariates: CaseCovariates | null | undefined,
  patientKey: string | null = activePatientKey,
  model: SefPersonalModel | null = activeModel,
): number | null {
  if (!model || !Number.isFinite(rawHz)) return null;
  const patientDy = patientKey ? (model.patientOffsets[patientKey] ?? 0) : 0;
  const value =
    model.gain * rawHz + model.offset + sefCovariateAdjustment(model.terms, covariates) + patientDy;
  return clamp(value, SEF_RANGE[0], SEF_RANGE[1]);
}
