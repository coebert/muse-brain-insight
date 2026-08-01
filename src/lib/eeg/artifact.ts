// Preprocessing stage tuned for depth-of-anaesthesia estimation.
//
// The OpenIBIS subparameters are log power ratios that lean on the 30-47 Hz
// band and on the shape of the whole spectrum, so the two artefacts that
// matter most on a frontal montage are (a) frontalis/temporalis EMG, which
// inflates the beta ratio and drives the index falsely high, and (b) large
// low-frequency ocular/movement transients, which inflate slow power and
// distort the mid-band reference. ECG/pacing spikes ("sawtooth" in the
// reference implementation) do both.
//
// This module repairs what can safely be repaired (bounded transients) and
// gates out what cannot (broadband EMG, saturation, periodic spikes, dropout)
// so contaminated epochs never enter the 30 s spectral history.

import { bandPower, type Psd } from "./dsp";

export interface DepthArtifactReport {
  /** Epoch may contribute to the depth spectral window. */
  usable: boolean;
  /** Fraction of samples that were repaired by transient winsorising (0-1). */
  repairedFraction: number;
  /** 30-45 Hz share of total power after repair (0-1). */
  emgIndex: number;
  /** Fraction of the epoch occupied by ocular/movement transients (0-1). */
  transientFraction: number;
  /** Regularity of periodic spike trains at 0.7-2.5 Hz — ECG/pacing (0-1). */
  ecgLikeness: number;
  /** Fraction of samples at the plausible EEG rail (0-1). */
  saturationFraction: number;
  /** Robust amplitude estimate (1.4826 x MAD), µV. */
  robustSigmaUv: number;
  /** Why the epoch was rejected, empty when accepted. */
  reasons: string[];
}

export interface DepthPreprocessResult {
  /** Repaired copy of the epoch — pass this to the depth estimator. */
  signal: Float64Array;
  report: DepthArtifactReport;
}

/** Thresholds; deliberately conservative so real EEG is never gated out. */
const RAIL_UV = 350;
/** Transients beyond this many robust sigmas are winsorised. */
const TRANSIENT_SIGMA = 5;
/** Absolute floor so a very quiet (suppressed) record is not "repaired" to death. */
const TRANSIENT_FLOOR_UV = 60;
/** Above this 30-45 Hz share the beta ratio is EMG, not EEG. */
const EMG_REJECT = 0.34;
const ECG_REJECT = 0.6;
const SATURATION_REJECT = 0.01;
const REPAIR_REJECT = 0.25;
const FLAT_UV = 0.5;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function median(values: ArrayLike<number>): number {
  const s = Array.from(values).sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 1.4826 x median absolute deviation — amplitude scale immune to blinks. */
export function robustSigma(data: Float64Array): number {
  const med = median(data);
  const dev = new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) dev[i] = Math.abs(data[i]! - med);
  return 1.4826 * median(dev);
}

/**
 * Regularity of a spike train in the 0.7-2.5 Hz range, measured on the
 * rectified derivative so it responds to QRS/pacing spikes rather than to
 * genuine delta rhythms.
 */
export function ecgLikeness(data: Float64Array, fs: number): number {
  const n = data.length;
  if (n < fs * 2) return 0;
  const d = new Float64Array(n - 1);
  let mean = 0;
  for (let i = 1; i < n; i++) {
    d[i - 1] = Math.abs(data[i]! - data[i - 1]!);
    mean += d[i - 1]!;
  }
  mean /= d.length;
  let denom = 0;
  for (let i = 0; i < d.length; i++) denom += (d[i]! - mean) ** 2;
  if (denom <= 0) return 0;

  // Only a peaky (impulsive) derivative can be a spike train.
  const peak = Math.max(...d);
  const crest = mean > 0 ? peak / mean : 0;
  if (crest < 6) return 0;

  const minLag = Math.floor(fs / 2.5);
  const maxLag = Math.floor(fs / 0.7);
  let best = 0;
  for (let lag = minLag; lag <= maxLag && lag < d.length; lag++) {
    let acc = 0;
    for (let i = lag; i < d.length; i++) acc += (d[i]! - mean) * (d[i - lag]! - mean);
    const r = acc / denom;
    if (r > best) best = r;
  }
  return clamp01(best);
}

/**
 * Repairs bounded ocular/movement transients and reports whether the epoch is
 * clean enough to feed the depth index.
 *
 * @param window filtered epoch, µV
 * @param psd PSD of the same (unrepaired) window
 * @param fs sample rate
 * @param qualityScore overall epoch quality, 0-1
 */
export function preprocessForDepth(
  window: Float64Array,
  psd: Psd,
  fs: number,
  qualityScore: number,
): DepthPreprocessResult {
  const n = window.length;
  const sigma = robustSigma(window);
  const limit = Math.max(TRANSIENT_FLOOR_UV, TRANSIENT_SIGMA * sigma);

  const signal = new Float64Array(n);
  let repaired = 0;
  let saturated = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = window[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    if (Math.abs(v) >= RAIL_UV) saturated++;
    if (v > limit) {
      signal[i] = limit;
      repaired++;
    } else if (v < -limit) {
      signal[i] = -limit;
      repaired++;
    } else {
      signal[i] = v;
    }
  }

  // Contiguous excursions past the limit are the ocular/movement transients;
  // isolated samples are noise and are covered by repairedFraction alone.
  let transientSamples = 0;
  let run = 0;
  const minRun = Math.max(2, Math.round(0.02 * fs));
  for (let i = 0; i <= n; i++) {
    const over = i < n && Math.abs(window[i]!) > limit;
    if (over) {
      run++;
    } else {
      if (run >= minRun) transientSamples += run;
      run = 0;
    }
  }

  const total =
    bandPower(psd, 0.5, 4) +
    bandPower(psd, 4, 8) +
    bandPower(psd, 8, 13) +
    bandPower(psd, 13, 30) +
    bandPower(psd, 30, 45);
  const emgIndex = total > 0 ? bandPower(psd, 30, 45) / total : 0;
  const ecg = ecgLikeness(window, fs);

  const repairedFraction = n ? repaired / n : 0;
  const transientFraction = n ? transientSamples / n : 0;
  const saturationFraction = n ? saturated / n : 0;
  const flat = max - min < FLAT_UV;

  const reasons: string[] = [];
  if (flat) reasons.push("No signal — electrode contact lost");
  if (saturationFraction > SATURATION_REJECT) reasons.push("Amplifier saturation");
  if (emgIndex > EMG_REJECT) reasons.push("Frontalis EMG contaminating the beta ratio");
  if (ecg > ECG_REJECT) reasons.push("Periodic spike artefact (ECG/pacing)");
  if (repairedFraction > REPAIR_REJECT) reasons.push("Movement/ocular artefact");
  if (qualityScore < 0.35) reasons.push("Overall signal quality too low");

  return {
    signal,
    report: {
      usable: reasons.length === 0,
      repairedFraction,
      emgIndex,
      transientFraction,
      ecgLikeness: ecg,
      saturationFraction,
      robustSigmaUv: sigma,
      reasons,
    },
  };
}