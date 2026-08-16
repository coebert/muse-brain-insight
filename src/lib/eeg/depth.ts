// OpenIBIS depth-of-anaesthesia index (streaming port).
//
// Direct re-implementation of the published openibis algorithm
// (Connor CW, "Open Reimplementation of the BIS Algorithms for Depth of
// Anesthesia", Anesth Analg 2022;135:855-864) — the same three log power
// ratio subparameters, the same suppression branch and the same mixer
// constants, restructured to run epoch-by-epoch on a live stream.
//
// Validated against a NumPy port of the reference openibis.m on synthetic
// sample sessions; see depth-validation.md for the agreement metrics.
//
// Deviations from the reference, all documented and quantified:
//  - epochs advance every 1 s (reference: 0.5 s); the 30 s spectral window
//    and 63 s suppression window are unchanged in duration.
//  - the sawtooth (ECG/artefact) detector is not implemented; artefact-heavy
//    epochs are instead excluded by the signal-quality gate.
//  - the Muse montage is frontal but is not the BIS sensor montage, and the
//    index is uncalibrated against clinical endpoints.
// Treat it as a trend, never as a target for drug titration on its own.

import {
  covariateAdjustment,
  type CaseCovariates,
  type CovariateAdjustment,
  type CovariateTerm,
} from "./covariates";
import { monitorEntropy, type MonitorEntropy } from "./entropy-monitor";
import { coebisAdjunct, NO_ADJUNCT, type AdjunctCorrection } from "./coebis-adjuncts";
import { getActiveMontageFeatures } from "./psi-features";

export interface DepthComponents {
  /** openibis component 1: mean 30-47 Hz power minus mid-band power, dB. */
  betaRatio: number;
  /** openibis component 2: trimmed log ratio of very-high to whole-band power concentration, dB. */
  synchFastSlow: number;
  /** openibis component 3: mean 0.5-4 Hz power minus mid-band power, dB. */
  slowWave: number;
  /** Burst-suppression ratio used by the mixer, 0-100 %. */
  bsr: number;
  sedationScore: number;
  generalScore: number;
  bsrScore: number;
}

export interface DepthReading {
  /** 0-100 index. Null until enough clean data has accrued. */
  index: number | null;
  /** Unsmoothed instantaneous value. */
  raw: number | null;
  state: DepthState;
  components: DepthComponents;
  /** Epoch was rejected by the artefact gate; the index is being held. */
  held: boolean;
  /** Seconds the index has been held on stale (pre-artefact) data. */
  heldSeconds: number;
  /** Share of the 30 s spectral window rejected by the gate (0-1). */
  gatedFraction: number;
  /** Why the current epoch was rejected, empty when accepted. */
  gateReasons: string[];
  /** A fitted BIS alignment was applied to the index. */
  bisAligned?: boolean;
  /** Entropy-monitor style State/Response Entropy for this epoch. */
  entropy?: MonitorEntropy | null;
  /** Adjunct (Entropy/PSI-informed) correction folded into COEBIS. */
  adjunct?: AdjunctCorrection;
  /**
   * COEBIS — the app's own continuously refitted index, derived from the
   * published OpenIBIS value by the correction learned from paired readings
   * against a commercial monitor. Null until a model has been fitted.
   */
  coebis?: number | null;
}

export type DepthState =
  "unreliable" | "awake" | "sedated" | "general_anaesthesia" | "deep" | "burst_suppression";

export const DEPTH_STATE_LABEL: Record<DepthState, string> = {
  unreliable: "Signal too poor",
  awake: "Awake / very light",
  sedated: "Sedated / light",
  general_anaesthesia: "General anaesthesia",
  deep: "Deep anaesthesia",
  burst_suppression: "Burst suppression",
};

/* ------------------------------------------------------------------ */
/* openibis helpers                                                     */

/** Sigmoid used by openibis to map a subparameter onto the 0-100 scale. */
function scurve(x: number, eo: number, emax: number, x50: number, xwidth: number): number {
  return eo - emax / (1 + Math.exp((x - x50) / xwidth));
}

/** Fittable sigmoid weights of the openibis mixer. */
export interface SigmoidWeights {
  eo: number;
  emax: number;
  x50: number;
  xwidth: number;
}

export interface DepthCalibration {
  /** Sedation branch sigmoid (beta ratio -> score). */
  sedation: SigmoidWeights;
  /** General-anaesthesia branch sigmoid (SynchFastSlow -> score). */
  general: SigmoidWeights;
  /**
   * Linear segment of the general branch, which drives the index in the deep
   * range where the sigmoid is inactive: SynchFastSlow xLo..xHi maps to yLo..yHi.
   */
  generalLinear: { xLo: number; xHi: number; yLo: number; yHi: number };
}

/** Published openibis constants (Connor CW, Anesth Analg 2022). */
export const DEFAULT_DEPTH_CALIBRATION: DepthCalibration = {
  sedation: { eo: 104.4, emax: 49.4, x50: -13.9, xwidth: 5.29 },
  general: { eo: 61.3, emax: 72.6, x50: -24.0, xwidth: 3.55 },
  generalLinear: { xLo: -60.89, xHi: -30, yLo: -40, yHi: 42 },
};

let activeCalibration: DepthCalibration = DEFAULT_DEPTH_CALIBRATION;

/**
 * Affine map fitted from pooled comparisons with a commercial BIS monitor
 * (see bis-drift.ts). Applied to the finished index only — the published
 * openibis subparameters and mixer constants are never altered.
 */
export interface BisAlignment {
  gain: number;
  offset: number;
  /**
   * Residual corrections at fixed points on the aligned scale, applied after
   * the affine map and linearly interpolated between knots. This is what lets
   * COEBIS finesse regions (e.g. light vs deep) where a single straight-line
   * correction still disagrees with the monitor.
   */
  knots?: BisKnot[];
  /** Paired readings the map was fitted on. */
  n: number;
  fittedAt: string;
  /** Row id of the fit in depth_bis_alignments, when it came from storage. */
  id?: string;
  /** 1-based fit sequence for this user, oldest fit = v1. */
  version?: number;
  /** True for the fit the app currently treats as the live model. */
  isActive?: boolean;
  /**
   * True while the fit is based on early evidence (below the full 30-reading /
   * 3-case bar). The number is shown, but always labelled as provisional.
   */
  provisional?: boolean;
  /** Agreement metrics recorded at fit time, for version comparison. */
  biasAfter?: number | null;
  maeAfter?: number | null;
  /**
   * Patient-specific residual corrections (COEBIS model v3). Applied on top of
   * the affine + knot map when the covariates of the case are known.
   */
  terms?: CovariateTerm[];
  /** "affine" (v1/v2) or "covariate" (v3). */
  family?: string;
}

/** One residual correction: at aligned index `x`, add `dy`. */
export interface BisKnot {
  x: number;
  dy: number;
}

/** Linear interpolation of the knot corrections, flat outside the range. */
export function knotCorrection(x: number, knots: BisKnot[] | undefined): number {
  if (!knots || !knots.length) return 0;
  const sorted = [...knots].sort((a, b) => a.x - b.x);
  if (x <= sorted[0]!.x) return sorted[0]!.dy;
  const last = sorted[sorted.length - 1]!;
  if (x >= last.x) return last.dy;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x || 1);
      return a.dy + t * (b.dy - a.dy);
    }
  }
  return last.dy;
}

let activeBisAlignment: BisAlignment | null = null;

export function getActiveBisAlignment(): BisAlignment | null {
  return activeBisAlignment;
}

export function setActiveBisAlignment(alignment: BisAlignment | null) {
  activeBisAlignment = alignment;
}

/**
 * Covariates of the case on screen. COEBIS uses them to personalise the
 * number; with none set the pooled correction is applied unchanged.
 */
let activeCovariates: CaseCovariates | null = null;

export function getActiveCaseCovariates(): CaseCovariates | null {
  return activeCovariates;
}

export function setActiveCaseCovariates(cov: CaseCovariates | null) {
  activeCovariates = cov;
}

/** The patient-specific part of the current COEBIS number, for explanation. */
export function activeCovariateAdjustment(
  alignment = activeBisAlignment,
  cov = activeCovariates,
): CovariateAdjustment {
  return covariateAdjustment(alignment?.terms, cov);
}

/** Map a raw index onto the aligned scale, clamped to 0–100. */
export function applyBisAlignment(
  index: number,
  alignment = activeBisAlignment,
  cov: CaseCovariates | null = activeCovariates,
  adjunct = 0,
): number {
  if (!alignment) return index;
  const affine = alignment.gain * index + alignment.offset;
  const shaped = affine + knotCorrection(affine, alignment.knots);
  return clamp(shaped + covariateAdjustment(alignment.terms, cov).total + adjunct, 0, 100);
}

/**
 * COEBIS: the proprietary index. Returns null when no model has been fitted
 * yet, so the UI can say so rather than mirroring OpenIBIS silently.
 */
export function computeCoebis(
  openIbis: number | null,
  alignment = activeBisAlignment,
  adjunct = 0,
): number | null {
  if (openIbis == null || !alignment) return null;
  return Math.round(applyBisAlignment(openIbis, alignment, activeCovariates, adjunct));
}

export function getActiveDepthCalibration(): DepthCalibration {
  return activeCalibration;
}

export function setActiveDepthCalibration(cal: DepthCalibration | null) {
  activeCalibration = cal ?? DEFAULT_DEPTH_CALIBRATION;
}

export function isDefaultCalibration(cal: DepthCalibration): boolean {
  const same = <T extends object>(a: T | undefined, b: T) =>
    (Object.keys(b) as (keyof T)[]).every(
      (p) => Math.abs(Number(a?.[p] ?? NaN) - Number(b[p])) < 1e-9,
    );
  return (
    same(cal.sedation, DEFAULT_DEPTH_CALIBRATION.sedation) &&
    same(cal.general, DEFAULT_DEPTH_CALIBRATION.general) &&
    same(
      cal.generalLinear ?? DEFAULT_DEPTH_CALIBRATION.generalLinear,
      DEFAULT_DEPTH_CALIBRATION.generalLinear,
    )
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamped linear interpolation (openibis `piecewise`). */
function piecewise(x: number, xp: number[], yp: number[]): number {
  const v = clamp(x, xp[0]!, xp[xp.length - 1]!);
  for (let i = 1; i < xp.length; i++) {
    if (v <= xp[i]!) {
      const t = (v - xp[i - 1]!) / (xp[i]! - xp[i - 1]!);
      return yp[i - 1]! + t * (yp[i]! - yp[i - 1]!);
    }
  }
  return yp[yp.length - 1]!;
}

/** Least-squares linear trend (openibis `baseline`). */
function detrend(x: Float64Array): Float64Array {
  const n = x.length;
  const sx = (n - 1) / 2;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sy += x[i]!;
    sxy += i * x[i]!;
    sxx += i * i;
  }
  const my = sy / n;
  const denom = sxx - n * sx * sx;
  const slope = denom === 0 ? 0 : (sxy - n * sx * my) / denom;
  const intercept = my - slope * sx;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i]! - (intercept + slope * i);
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const r = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(r);
  const hi = Math.ceil(r);
  return sorted[lo]! + (r - lo) * (sorted[hi]! - sorted[lo]!);
}

/** Mean of the values between the lo-th and hi-th percentile (openibis `prctmean`). */
function prctmean(values: number[], lo: number, hi: number): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return NaN;
  const sorted = [...clean].sort((a, b) => a - b);
  const a = percentile(sorted, lo);
  const b = percentile(sorted, hi);
  const sel = clean.filter((v) => v >= a && v <= b);
  return sel.length ? sel.reduce((s, v) => s + v, 0) / sel.length : NaN;
}

/** Mean after discarding pct % of the sample, split between the tails (MATLAB `trimmean`). */
function trimmean(values: number[], pct: number): number {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return NaN;
  const k = Math.floor((clean.length * pct) / 100 / 2);
  const sel = clean.length - 2 * k > 0 ? clean.slice(k, clean.length - k) : clean;
  return sel.reduce((s, v) => s + v, 0) / sel.length;
}

/* ------------------------------------------------------------------ */
/* Spectral estimate on the openibis 0.5 Hz grid                        */

const BIN_HZ = 0.5;
const MAX_HZ = 47;
const NBINS = Math.round(MAX_HZ / BIN_HZ) + 1; // 0, 0.5 ... 47 Hz

function blackman(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / (n - 1);
    w[i] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
  }
  return w;
}

function dftPower(x: Float64Array, fs: number): Float64Array {
  // Goertzel-style direct evaluation on the exact 0.5 Hz openibis grid; the
  // window is 4 s so every bin lands on a Fourier frequency.
  const n = x.length;
  const w = blackman(n);
  const d = detrend(x);
  let winPower = 0;
  const xw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xw[i] = d[i]! * w[i]!;
    winPower += w[i]! * w[i]!;
  }
  const out = new Float64Array(NBINS);
  for (let k = 0; k < NBINS; k++) {
    const f = (2 * Math.PI * (k * BIN_HZ)) / fs;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += xw[i]! * Math.cos(f * i);
      im -= xw[i]! * Math.sin(f * i);
    }
    out[k] = (2 * (re * re + im * im)) / (n * winPower);
  }
  return out;
}

const binOf = (hz: number) => Math.round(hz / BIN_HZ);

function meanBandPowerDb(rows: (Float64Array | null)[], from: number, to: number): number {
  const a = binOf(from);
  const b = binOf(to);
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    if (!row) continue;
    for (let k = a; k <= b; k++) {
      const v = row[k]!;
      if (v > 0) {
        sum += 10 * Math.log10(v);
        n++;
      }
    }
  }
  return n ? sum / n : NaN;
}

function concentration(row: Float64Array, fromA: number, toA: number, fromB: number, toB: number) {
  const a0 = binOf(fromA);
  const b0 = binOf(toA);
  const a1 = binOf(fromB);
  let sum = 0;
  let n = 0;
  for (let k = a0; k <= b0; k++) {
    sum += row[k]! * row[a1 + (k - a0)]!;
    n++;
  }
  return Math.sqrt(n ? sum / n : NaN);
}

/* ------------------------------------------------------------------ */

export function depthState(index: number | null, bsr: number): DepthState {
  if (index == null) return "unreliable";
  if (bsr >= 5 || index < 20) return "burst_suppression";
  if (index < 40) return "deep";
  if (index < 60) return "general_anaesthesia";
  if (index < 80) return "sedated";
  return "awake";
}

export function depthTone(state: DepthState): "default" | "signal" | "caution" | "critical" {
  switch (state) {
    case "general_anaesthesia":
      return "signal";
    case "awake":
    case "sedated":
    case "deep":
      return "caution";
    case "burst_suppression":
      return "critical";
    default:
      return "default";
  }
}

/** openibis mixer — verbatim constants from the published algorithm. */
export function depthMixer(
  c1: number,
  c2: number,
  c3: number,
  bsr: number,
  cal: DepthCalibration = getActiveDepthCalibration(),
) {
  const s = cal.sedation;
  const g = cal.general;
  const gl = cal.generalLinear ?? DEFAULT_DEPTH_CALIBRATION.generalLinear;
  const sedationScore = scurve(c1, s.eo, s.emax, s.x50, s.xwidth);
  let generalScore = piecewise(c2, [gl.xLo, gl.xHi], [gl.yLo, gl.yHi]);
  if (c2 >= gl.xHi) generalScore += scurve(c2, g.eo, g.emax, g.x50, g.xwidth);
  const bsrScore = piecewise(bsr, [0, 100], [50, 0]);
  const generalWeight = piecewise(c3, [0, 5], [0.5, 1]) * (generalScore < sedationScore ? 1 : 0);
  const bsrWeight = piecewise(bsr, [10, 50], [0, 1]);
  const x = sedationScore * (1 - generalWeight) + generalScore * generalWeight;
  const index =
    piecewise(x, [-40, 10, 97, 110], [0, 10, 97, 100]) * (1 - bsrWeight) + bsrScore * bsrWeight;
  return { index, sedationScore, generalScore, bsrScore };
}

const SPECTRAL_WINDOW_S = 30;
const BSR_WINDOW_S = 63;
/** openibis blanks the spectrum for 4 epochs (2 s) after any suppressed epoch. */
const SUPPRESSION_BLANK_EPOCHS = 2;
/** Suppression rule: 2 s detrended segment staying within +/-5 µV. */
const SUPPRESSION_UV = 5;

/** Stateful estimator: feed the most recent 4 s of signal once per epoch. */
export class DepthIndexEstimator {
  private psdHistory: (Float64Array | null)[] = [];
  private bsrMap: number[] = [];
  private epochSeconds = 1;
  private heldEpochs = 0;

  reset() {
    this.psdHistory = [];
    this.bsrMap = [];
    this.heldEpochs = 0;
  }

  /**
   * @param window most recent 4 s of artefact-repaired signal, µV
   * @param fs sample rate
   * @param gate artefact gate: whether this epoch may enter the spectral
   *   window, plus the reasons it was rejected
   * @param epochSeconds hop between calls, seconds
   */
  update(
    window: Float64Array,
    fs: number,
    gate: { usable: boolean; reasons?: string[] },
    epochSeconds = 1,
  ): DepthReading {
    this.epochSeconds = epochSeconds;

    // --- suppression branch (openibis `suppression`) ----------------------
    const twoSec = window.subarray(Math.max(0, window.length - Math.round(2 * fs)));
    const d = detrend(twoSec);
    let suppressed = 1;
    for (let i = 0; i < d.length; i++) {
      if (Math.abs(d[i]!) > SUPPRESSION_UV) {
        suppressed = 0;
        break;
      }
    }
    this.bsrMap.push(suppressed);
    const bsrKeep = Math.max(1, Math.round(BSR_WINDOW_S / epochSeconds));
    while (this.bsrMap.length > bsrKeep) this.bsrMap.shift();
    const bsr = (100 * this.bsrMap.reduce((a, b) => a + b, 0)) / this.bsrMap.length;

    // --- spectrum (openibis `logPowerRatios`) -----------------------------
    const blank = Math.max(1, Math.round(SUPPRESSION_BLANK_EPOCHS / epochSeconds));
    const recentlySuppressed = this.bsrMap.slice(-blank).some((v) => v === 1);
    const usable = !recentlySuppressed && gate.usable;
    this.psdHistory.push(usable ? dftPower(window, fs) : null);
    const keep = Math.max(1, Math.round(SPECTRAL_WINDOW_S / epochSeconds));
    while (this.psdHistory.length > keep) this.psdHistory.shift();
    // Suppressed epochs are a clinical state, not an artefact — only the
    // artefact gate counts as "held".
    if (gate.usable) this.heldEpochs = 0;
    else this.heldEpochs++;

    const rows = this.psdHistory.filter((r): r is Float64Array => r != null);

    let c1 = NaN;
    let c2 = NaN;
    let c3 = NaN;
    if (rows.length) {
      const midPerBin: number[] = [];
      for (let k = binOf(11); k <= binOf(20); k++) {
        let s = 0;
        let n = 0;
        for (const row of rows) {
          if (row[k]! > 0) {
            s += 10 * Math.log10(row[k]!);
            n++;
          }
        }
        if (n) midPerBin.push(s / n);
      }
      const midBandPower = prctmean(midPerBin, 50, 100);
      const ratios = rows.map((row) => {
        const vhigh = concentration(row, 39.5, 46.5, 40, 47);
        const whole = concentration(row, 0.5, 46.5, 1, 47);
        return 10 * Math.log10(vhigh / whole);
      });
      c1 = meanBandPowerDb(rows, 30, 47) - midBandPower;
      c2 = trimmean(ratios, 50);
      c3 = meanBandPowerDb(rows, 0.5, 4) - midBandPower;
    }

    const valid = Number.isFinite(c1) && Number.isFinite(c2) && Number.isFinite(c3);
    const mixed = valid
      ? depthMixer(c1, c2, c3, bsr)
      : {
          index: NaN,
          sedationScore: NaN,
          generalScore: NaN,
          bsrScore: piecewise(bsr, [0, 100], [50, 0]),
        };

    // Deeply suppressed records have no usable spectrum: fall back to the
    // pure suppression branch rather than reporting nothing.
    const fallback = bsr >= 50 ? mixed.bsrScore : null;
    // `index` is always the published OpenIBIS value — never corrected.
    const rawValue = valid ? clamp(mixed.index, 0, 100) : fallback;

    const components: DepthComponents = {
      betaRatio: c1,
      synchFastSlow: c2,
      slowWave: c3,
      bsr,
      sedationScore: mixed.sedationScore,
      generalScore: mixed.generalScore,
      bsrScore: mixed.bsrScore,
    };

    const index = rawValue == null ? null : Math.round(rawValue);
    const gatedFraction = this.psdHistory.length
      ? this.psdHistory.filter((r) => r == null).length / this.psdHistory.length
      : 1;

    // Entropy-monitor style SE/RE on the same rolling spectra, then the
    // Entropy/PSI-informed adjunct that finishes the COEBIS number.
    const entropy = monitorEntropy(this.psdHistory, bsr, BIN_HZ, epochSeconds);
    const aligned =
      rawValue == null || !activeBisAlignment ? null : applyBisAlignment(rawValue, activeBisAlignment);
    const adjunct =
      aligned == null
        ? NO_ADJUNCT
        : coebisAdjunct({
            aligned,
            entropy,
            montage: getActiveMontageFeatures(),
            bsr,
            quality: 1 - gatedFraction,
          });
    const coebis = computeCoebis(rawValue, activeBisAlignment, adjunct.total);
    return {
      index,
      raw: rawValue == null ? null : Math.round(rawValue),
      state: depthState(index, bsr),
      components,
      held: !gate.usable && index != null,
      heldSeconds: this.heldEpochs * epochSeconds,
      gatedFraction,
      gateReasons: gate.reasons ?? [],
      bisAligned: activeBisAlignment != null,
      entropy,
      adjunct,
      coebis,
    };
  }

  /** Seconds of data currently contributing to the spectral window. */
  get maturity(): number {
    return this.psdHistory.length * this.epochSeconds;
  }
}
