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
  /** Fraction of samples replaced by transient repair (0-1). */
  repairedFraction: number;
  /** 30-45 Hz share of total power after repair (0-1). */
  emgIndex: number;
  /** Current 30-45 Hz power divided by its running clean-epoch baseline. */
  emgSurge: number;
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
/**
 * A relative share alone misses EMG riding on high-amplitude slow activity
 * (deep anaesthesia), so the gate also watches for a step rise in absolute
 * 30-45 Hz power against the running baseline of accepted epochs.
 */
const EMG_SURGE_REJECT = 3;
/** Absolute 30-45 Hz power floor, µV²; below this a surge is just quiet noise. */
const EMG_POWER_FLOOR = 0.5;
const ECG_REJECT = 0.6;
/** Below this robust amplitude the record is suppressed, where the spike detector misfires. */
const ECG_MIN_SIGMA_UV = 5;
const SATURATION_REJECT = 0.01;
const REPAIR_REJECT = 0.08;
const FLAT_UV = 0.5;
const BASELINE_EPOCHS = 120;

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
 * Replaces contiguous excursions beyond `limit` with a linear ramp between the
 * last and first in-range samples. Blanking beats clipping here: a clipped
 * blink still injects a broadband step into the 30-47 Hz band the depth index
 * depends on, whereas an interpolated segment injects almost nothing.
 */
function repairTransients(window: Float64Array, limit: number, fs: number) {
  const n = window.length;
  const signal = Float64Array.from(window);
  const minRun = Math.max(2, Math.round(0.01 * fs));
  const pad = Math.round(0.02 * fs); // taper the shoulders of each excursion
  let repaired = 0;
  let transientSamples = 0;
  let i = 0;
  while (i < n) {
    if (Math.abs(window[i]!) <= limit) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && Math.abs(window[j]!) > limit) j++;
    const runLen = j - i;
    const a = Math.max(0, i - pad);
    const b = Math.min(n - 1, j - 1 + pad);
    const va = signal[a]!;
    const vb = signal[b]!;
    for (let k = a; k <= b; k++) {
      signal[k] = va + ((vb - va) * (k - a)) / Math.max(1, b - a);
      repaired++;
    }
    if (runLen >= minRun) transientSamples += b - a + 1;
    i = j;
  }
  return { signal, repaired, transientSamples };
}

/**
 * Stateful preprocessing gate for the depth index. Holds a running baseline of
 * clean high-frequency power so EMG can be detected as a *change*, not only as
 * a share of total power (which slow-wave-dominated deep anaesthesia hides).
 */
export class DepthArtifactGate {
  private gammaBaseline: number[] = [];

  reset() {
    this.gammaBaseline = [];
  }

  /**
   * @param window filtered epoch, µV
   * @param psd PSD of the same (unrepaired) window
   * @param fs sample rate
   * @param qualityScore overall epoch quality, 0-1
   */
  evaluate(
    window: Float64Array,
    psd: Psd,
    fs: number,
    qualityScore: number,
  ): DepthPreprocessResult {
    const n = window.length;
    const sigma = robustSigma(window);
    const limit = Math.max(TRANSIENT_FLOOR_UV, TRANSIENT_SIGMA * sigma);

    let saturated = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = window[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
      if (Math.abs(v) >= RAIL_UV) saturated++;
    }

    const { signal, repaired, transientSamples } = repairTransients(window, limit, fs);

    const gamma = bandPower(psd, 30, 45);
    const total =
      bandPower(psd, 0.5, 4) +
      bandPower(psd, 4, 8) +
      bandPower(psd, 8, 13) +
      bandPower(psd, 13, 30) +
      gamma;
    const emgIndex = total > 0 ? gamma / total : 0;
    const base = this.gammaBaseline.length ? median(this.gammaBaseline) : NaN;
    const emgSurge =
      Number.isFinite(base) && base > 0 && gamma > EMG_POWER_FLOOR ? gamma / base : 1;
    const ecg = sigma >= ECG_MIN_SIGMA_UV ? ecgLikeness(window, fs) : 0;

    const repairedFraction = n ? repaired / n : 0;
    const transientFraction = n ? transientSamples / n : 0;
    const saturationFraction = n ? saturated / n : 0;
    const flat = max - min < FLAT_UV;

    const reasons: string[] = [];
    if (flat) reasons.push("No signal — electrode contact lost");
    if (saturationFraction > SATURATION_REJECT) reasons.push("Amplifier saturation");
    if (emgIndex > EMG_REJECT || emgSurge > EMG_SURGE_REJECT) {
      reasons.push("Frontalis EMG contaminating the beta ratio");
    }
    if (ecg > ECG_REJECT) reasons.push("Periodic spike artefact (ECG/pacing)");
    if (repairedFraction > REPAIR_REJECT) reasons.push("Movement/ocular artefact");
    if (qualityScore < 0.35) reasons.push("Overall signal quality too low");

    const usable = reasons.length === 0;
    // Baseline tracks accepted epochs only, so an artefact never raises the bar
    // that detects the next one.
    if (usable && Number.isFinite(gamma)) {
      this.gammaBaseline.push(gamma);
      if (this.gammaBaseline.length > BASELINE_EPOCHS) this.gammaBaseline.shift();
    }

    return {
      signal,
      report: {
        usable,
        repairedFraction,
        emgIndex,
        emgSurge,
        transientFraction,
        ecgLikeness: ecg,
        saturationFraction,
        robustSigmaUv: sigma,
        reasons,
      },
    };
  }
}