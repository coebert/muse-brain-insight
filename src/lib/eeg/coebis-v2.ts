/**
 * COEBIS-2 — a depth-of-anaesthesia index fitted from raw EEG, not derived
 * from the published OpenIBIS constants.
 *
 * The original COEBIS number is the OpenIBIS re-implementation in `depth.ts`
 * rescaled by a stored calibration. That design inherits OpenIBIS's fixed
 * sub-parameters and sigmoid mixer, so calibration can only move the answer up
 * and down — it can never change *what the index looks at*.
 *
 * COEBIS-2 replaces the estimator itself. Every term below was fitted on
 * simultaneous bedside EEG and BIS from VitalDB surgical cases, graded with
 * leave-patients-out cross-validation, so no coefficient was chosen on a
 * patient it was later scored against. The model is deliberately a *linear*
 * model over interpretable spectral descriptors: band powers, relative powers,
 * the classic fast/slow ratios, spectral edges, entropies, burst-suppression
 * and short-horizon trends. That keeps every reading explainable at the
 * bedside — each term's contribution can be printed — and keeps it from
 * memorising individual patients the way a tree ensemble did (which scored
 * worse out of sample here, MAE 7.77 vs 7.27 on the first fold set).
 *
 * Honesty constraints:
 *  - The fit belongs to the acquisition lineage it was trained on. Applying it
 *    to a different montage or sample rate is an extrapolation and is labelled
 *    as such by {@link coebisV2Applicability}, never silently allowed.
 *  - The index is not a BIS. It is trained to agree with one, and its held-out
 *    disagreement is published alongside it.
 */

import { computePsd, spectralEntropies, type Psd } from "./dsp";
import weights from "./coebis-v2-weights.json";

export const COEBIS_V2_EPOCH_SECONDS = 4;
/** Suppression is scored on 0.5 s segments below this peak-to-peak, in µV. */
export const COEBIS_V2_SUPPRESSION_UV = 5;
/** Trailing window for the suppression ratio, in seconds. */
export const COEBIS_V2_SR_WINDOW = 60;
/** Output smoothing time constant, in seconds. */
export const COEBIS_V2_SMOOTHING_TAU = 15;

export interface CoebisV2Model {
  /** Ordered model term names; the first weight is the intercept. */
  names: string[];
  w: number[];
  mu: number[];
  sd: number[];
  meta: {
    lineage: string;
    cases: number;
    rows: number;
    heldOutMae: number;
    heldOutWithin5: number;
    baselineMae: number;
    fittedAt: string;
  };
}

export const COEBIS_V2_MODEL = weights as CoebisV2Model;

/* ------------------------------------------------------------------ */
/* Spectral descriptors                                                */
/* ------------------------------------------------------------------ */

function bandPower(psd: Psd, lo: number, hi: number): number {
  let sum = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f >= lo && f < hi) sum += psd.power[i]! * psd.binWidth;
  }
  return sum;
}

function edgeFreq(psd: Psd, fraction: number, lo = 0.5, hi = 45): number {
  let total = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f >= lo && f <= hi) total += psd.power[i]!;
  }
  if (total <= 0) return lo;
  let acc = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f < lo || f > hi) continue;
    acc += psd.power[i]!;
    if (acc >= total * fraction) return f;
  }
  return hi;
}

function alphaPeak(psd: Psd): { freq: number; prominence: number } {
  let best = 0;
  let bestF = 0;
  let floor = 0;
  let floorN = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f >= 7 && f <= 17 && psd.power[i]! > best) {
      best = psd.power[i]!;
      bestF = f;
    }
    if (f >= 2 && f <= 30) {
      floor += psd.power[i]!;
      floorN++;
    }
  }
  const mean = floorN ? floor / floorN : 0;
  return { freq: bestF, prominence: mean > 0 ? Math.log10((best + 1e-12) / (mean + 1e-12)) : 0 };
}

const L = (x: number) => Math.log10(Math.max(x, 1e-9));

export type CoebisV2Features = Record<string, number>;

/**
 * The purely spectral descriptors, from a power spectrum alone.
 *
 * Split out so a stored spectrum — an imported collection that kept its
 * spectra but not its waveform — can be scored with the same terms the fit
 * uses. The amplitude and suppression terms are not derivable from a spectrum
 * and are supplied separately by the caller.
 */
export function coebisV2SpectralFeatures(psd: Psd): CoebisV2Features {
  const total = bandPower(psd, 0.5, 45);
  const slow = bandPower(psd, 0.5, 1);
  const delta = bandPower(psd, 1, 4);
  const theta = bandPower(psd, 4, 8);
  const alpha = bandPower(psd, 8, 13);
  const beta = bandPower(psd, 13, 30);
  const gamma = bandPower(psd, 30, 45);
  const rel = (x: number) => x / Math.max(total, 1e-12);
  const sef95 = edgeFreq(psd, 0.95);
  const ent = spectralEntropies(psd, sef95);
  const peak = alphaPeak(psd);

  return {
    logTotal: L(total),
    logSlow: L(slow),
    logDelta: L(delta),
    logTheta: L(theta),
    logAlpha: L(alpha),
    logBeta: L(beta),
    logGamma: L(gamma),
    relSlow: rel(slow),
    relDelta: rel(delta),
    relTheta: rel(theta),
    relAlpha: rel(alpha),
    relBeta: rel(beta),
    relGamma: rel(gamma),
    betaRatio: L(beta / Math.max(alpha, 1e-12)),
    syncFastSlow: L((beta + gamma) / Math.max(delta + theta, 1e-12)),
    alphaDelta: L(alpha / Math.max(delta, 1e-12)),
    thetaAlpha: L(theta / Math.max(alpha, 1e-12)),
    sef50: edgeFreq(psd, 0.5),
    sef75: edgeFreq(psd, 0.75),
    sef90: edgeFreq(psd, 0.9),
    sef95,
    entShannon: ent.shannon,
    entSe95: ent.se95,
    entState: ent.state,
    entResponse: ent.response,
    peakFreq: peak.freq,
    peakProminence: peak.prominence,
  };
}

/** Every descriptor a single analysis window supports. */
export function coebisV2WindowFeatures(
  window: Float64Array,
  sampleRate: number,
): { features: CoebisV2Features; suppressionFraction: number } {
  const psd = computePsd(window, sampleRate);
  const spectral = coebisV2SpectralFeatures(psd);

  const seg = Math.max(1, Math.round(0.5 * sampleRate));
  let suppressed = 0;
  let segments = 0;
  let sumSquares = 0;
  let ptpMax = 0;
  for (let i = 0; i + seg <= window.length; i += seg) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i; j < i + seg; j++) {
      const v = window[j]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sumSquares += v * v;
    }
    const ptp = hi - lo;
    if (ptp > ptpMax) ptpMax = ptp;
    if (ptp < COEBIS_V2_SUPPRESSION_UV) suppressed++;
    segments++;
  }
  const rms = Math.sqrt(sumSquares / Math.max(window.length, 1));
  const suppressionFraction = segments ? suppressed / segments : 0;

  return {
    suppressionFraction,
    features: {
      ...spectral,
      logRms: L(rms),
      logPtp: L(ptpMax),
      suppFraction: suppressionFraction,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Estimator                                                           */
/* ------------------------------------------------------------------ */

/** Descriptors the model remembers a trailing mean and deviation of. */
export const COEBIS_V2_LAG_TERMS = [
  "betaRatio",
  "syncFastSlow",
  "sef95",
  "entState",
  "relDelta",
  "relBeta",
  "logTotal",
  "sr60",
  "logPtp",
];
const LAG_TAUS = [15, 60];

export interface CoebisV2Covariates {
  ageYears?: number | null;
  sexMale?: boolean | null;
}

export interface CoebisV2Reading {
  /** Smoothed index, 0-100. */
  index: number;
  /** Index before output smoothing — useful for auditing, not for display. */
  instant: number;
  /** Trailing 60 s suppression ratio, %. */
  suppressionRatio: number;
  /** Every model term's value at this moment. */
  terms: CoebisV2Features;
  /** The eight largest signed contributions to this reading, in index points. */
  drivers: { term: string; contribution: number }[];
}

/**
 * Stateful COEBIS-2 estimator. Feed it one analysis window per second; it
 * carries the trailing suppression ratio, the trend memory the fit was given,
 * and the output smoothing.
 */
export class CoebisV2Estimator {
  private srHistory: { t: number; fraction: number }[] = [];
  private trend30: { t: number; features: CoebisV2Features }[] = [];
  private ema = new Map<string, number>();
  private smoothed: number | null = null;
  private clock = 0;
  private lastT: number | null = null;

  constructor(
    private readonly covariates: CoebisV2Covariates = {},
    private readonly model: CoebisV2Model = COEBIS_V2_MODEL,
  ) {}

  reset(): void {
    this.srHistory = [];
    this.trend30 = [];
    this.ema.clear();
    this.smoothed = null;
    this.clock = 0;
    this.lastT = null;
  }

  update(window: Float64Array, sampleRate: number, stepSeconds = 1): CoebisV2Reading | null {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
    if (window.length < COEBIS_V2_EPOCH_SECONDS * sampleRate * 0.5) return null;

    const { features, suppressionFraction } = coebisV2WindowFeatures(window, sampleRate);
    return this.updateFromFeatures(features, suppressionFraction, stepSeconds);
  }

  /**
   * Advance the estimator from descriptors computed elsewhere.
   *
   * Used when the waveform is gone and only a stored spectrum survives, so an
   * imported collection can be read on exactly the terms the fit uses. The
   * caller owns the honesty of the amplitude and suppression inputs.
   */
  updateFromFeatures(
    input: CoebisV2Features,
    suppressionFraction: number,
    stepSeconds = 1,
  ): CoebisV2Reading {
    this.clock += stepSeconds;
    const t = this.clock;
    const features: CoebisV2Features = { ...input };

    this.srHistory.push({ t, fraction: suppressionFraction });
    while (this.srHistory.length && t - this.srHistory[0]!.t > COEBIS_V2_SR_WINDOW) {
      this.srHistory.shift();
    }
    features["sr60"] =
      (this.srHistory.reduce((a, h) => a + h.fraction, 0) /
        Math.max(this.srHistory.length, 1)) *
      100;

    this.trend30.push({ t, features });
    while (this.trend30.length && t - this.trend30[0]!.t > 30) this.trend30.shift();
    const mean = (k: string) =>
      this.trend30.reduce((a, r) => a + (r.features[k] ?? 0), 0) /
      Math.max(this.trend30.length, 1);
    features["sef95Mean30"] = mean("sef95");
    features["relBetaMean30"] = mean("relBeta");
    features["relDeltaMean30"] = mean("relDelta");
    features["entStateMean30"] = mean("entState");
    features["sef95Delta30"] = (features["sef95"] ?? 0) - features["sef95Mean30"]!;

    const terms = this.designRow(features, t);
    const { value, drivers } = this.predict(terms);
    const instant = Math.min(100, Math.max(0, value));

    const dt = this.lastT == null ? 1 : Math.max(t - this.lastT, 1);
    this.lastT = t;
    const alpha = 1 - Math.exp(-dt / COEBIS_V2_SMOOTHING_TAU);
    this.smoothed =
      this.smoothed == null ? instant : this.smoothed + alpha * (instant - this.smoothed);

    return {
      index: Math.round(this.smoothed),
      instant,
      suppressionRatio: features["sr60"]!,
      terms,
      drivers,
    };
  }


  /** Squares, suppression interactions, covariates and the trend memory. */
  private designRow(features: CoebisV2Features, t: number): CoebisV2Features {
    const row: CoebisV2Features = { ...features };
    const sr = (features["sr60"] ?? 0) / 100;
    for (const k of ["betaRatio", "syncFastSlow", "sef95", "entState", "relDelta", "relBeta"]) {
      const v = features[k] ?? 0;
      row[`${k}^2`] = v * v;
      row[`${k}*sr`] = v * sr;
    }
    row["sr^2"] = sr * sr;
    const age = this.covariates.ageYears ?? 55;
    row["ageZ"] = (age - 55) / 20;
    row["male"] =
      this.covariates.sexMale == null ? 0.5 : this.covariates.sexMale ? 1 : 0;

    const dt = this.lastT == null ? 1 : Math.max(t - this.lastT, 1);
    for (const tau of LAG_TAUS) {
      const a = 1 - Math.exp(-dt / tau);
      for (const k of COEBIS_V2_LAG_TERMS) {
        const v = row[k] ?? 0;
        const key = `${k}~${tau}s`;
        const prev = this.ema.get(key);
        const next = prev == null ? v : prev + a * (v - prev);
        this.ema.set(key, next);
        row[key] = next;
        row[`${k}d${tau}s`] = v - next;
      }
    }
    return row;
  }

  private predict(row: CoebisV2Features): {
    value: number;
    drivers: { term: string; contribution: number }[];
  } {
    const { names, w, mu, sd } = this.model;
    let value = w[0] ?? 0;
    const contributions: { term: string; contribution: number }[] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const scale = sd[i] || 1;
      const z = ((row[name] ?? mu[i] ?? 0) - (mu[i] ?? 0)) / scale;
      const c = (w[i + 1] ?? 0) * z;
      value += c;
      contributions.push({ term: name, contribution: c });
    }
    contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    return { value, drivers: contributions.slice(0, 8) };
  }
}

/* ------------------------------------------------------------------ */
/* Lineage guard                                                       */
/* ------------------------------------------------------------------ */

export type CoebisV2Applicability = "fitted" | "near" | "extrapolated";

/**
 * Whether the fit may be read on a given acquisition setup.
 *
 * `fitted` — the montage and rate the coefficients were trained on.
 * `near` — a frontal montage at a comparable rate: readable, but the
 *   disagreement published for the fitted lineage does not transfer.
 * `extrapolated` — anything else; the number must not be shown as COEBIS-2.
 */
export function coebisV2Applicability(
  lineageKey: string | null | undefined,
  sampleRate?: number | null,
  channels?: string[] | null,
): CoebisV2Applicability {
  if (lineageKey && lineageKey === COEBIS_V2_MODEL.meta.lineage) return "fitted";
  const frontal = (channels ?? []).every((c) => /AF7|AF8|FP1|FP2|F7|F8/i.test(c));
  const rate = sampleRate ?? 0;
  if (frontal && (channels ?? []).length > 0 && rate >= 100 && rate <= 1000) return "near";
  return "extrapolated";
}
