// Signal-processing primitives for EEG analysis.
// Everything here is pure and framework-free so it can be unit-reasoned about.

export const MUSE_SAMPLE_RATE = 256;

/** Radix-2 in-place FFT. re/im must be power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

const windowCache = new Map<number, Float64Array>();
function hannCached(n: number): Float64Array {
  let w = windowCache.get(n);
  if (!w) {
    w = hann(n);
    windowCache.set(n, w);
  }
  return w;
}

export interface Psd {
  /** Frequency of each bin, Hz */
  freqs: Float64Array;
  /** Power spectral density, µV²/Hz */
  power: Float64Array;
  binWidth: number;
}

/** Single-taper (Hann) periodogram. Input is detrended internally. */
export function computePsd(signal: Float64Array, fs = MUSE_SAMPLE_RATE): Psd {
  let n = 1;
  while (n * 2 <= signal.length) n *= 2;
  const seg = signal.subarray(signal.length - n);

  let mean = 0;
  for (let i = 0; i < n; i++) mean += seg[i]!;
  mean /= n;

  const w = hannCached(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let winPower = 0;
  for (let i = 0; i < n; i++) {
    re[i] = (seg[i]! - mean) * w[i]!;
    winPower += w[i]! * w[i]!;
  }
  fft(re, im);

  const half = n / 2;
  const freqs = new Float64Array(half);
  const power = new Float64Array(half);
  const scale = 1 / (fs * winPower);
  for (let k = 0; k < half; k++) {
    const mag = re[k]! * re[k]! + im[k]! * im[k]!;
    freqs[k] = (k * fs) / n;
    power[k] = (k === 0 ? mag : 2 * mag) * scale;
  }
  return { freqs, power, binWidth: fs / n };
}

export function bandPower(psd: Psd, lo: number, hi: number): number {
  let sum = 0;
  for (let k = 0; k < psd.freqs.length; k++) {
    const f = psd.freqs[k]!;
    if (f >= lo && f < hi) sum += psd.power[k]! * psd.binWidth;
  }
  return sum;
}

export function spectralEdge(psd: Psd, fraction: number, maxHz = 30): number {
  let total = 0;
  for (let k = 0; k < psd.freqs.length; k++) {
    if (psd.freqs[k]! <= maxHz) total += psd.power[k]!;
  }
  if (total <= 0) return 0;
  let acc = 0;
  for (let k = 0; k < psd.freqs.length; k++) {
    if (psd.freqs[k]! > maxHz) break;
    acc += psd.power[k]!;
    if (acc / total >= fraction) return psd.freqs[k]!;
  }
  return maxHz;
}

/**
 * Normalised Shannon entropy of the PSD over [lo, hi), as used by the
 * Datex-Ohmeda Entropy Module (Viertiö-Oja et al., Acta Anaesthesiol Scand
 * 2004): the PSD is normalised to a probability distribution over the band,
 * the Shannon entropy is taken, and the result is divided by log(N) so a flat
 * (awake-like) spectrum gives 1 and a single-frequency spectrum gives 0.
 */
export function spectralEntropy(psd: Psd, lo: number, hi: number): number {
  let total = 0;
  let n = 0;
  for (let k = 0; k < psd.freqs.length; k++) {
    const f = psd.freqs[k]!;
    if (f < lo || f >= hi) continue;
    total += psd.power[k]!;
    n++;
  }
  if (n < 2 || total <= 0) return 0;
  let h = 0;
  for (let k = 0; k < psd.freqs.length; k++) {
    const f = psd.freqs[k]!;
    if (f < lo || f >= hi) continue;
    const p = psd.power[k]! / total;
    if (p > 0) h -= p * Math.log(p);
  }
  return Math.min(1, Math.max(0, h / Math.log(n)));
}

export interface SpectralEntropy {
  /** Shannon entropy of the whole analysed spectrum, 0.5-45 Hz (0-1). */
  shannon: number;
  /** Entropy restricted to 0.5 Hz-SEF95, i.e. the 95 % power band (0-1). */
  se95: number;
  /** State-entropy-like index, 0.8-32 Hz — cortical, EMG-free (0-1). */
  state: number;
  /** Response-entropy-like index, 0.8-45 Hz — includes frontal EMG (0-1). */
  response: number;
}

/** All four entropy variants from one PSD. `sef95` comes from spectralEdge. */
export function spectralEntropies(psd: Psd, sef95: number): SpectralEntropy {
  return {
    shannon: spectralEntropy(psd, 0.5, 45),
    se95: spectralEntropy(psd, 0.5, Math.max(sef95, 2)),
    state: spectralEntropy(psd, 0.8, 32),
    response: spectralEntropy(psd, 0.8, 45),
  };
}

/* ------------------------------------------------------------------ */
/* Biquad filtering (RBJ cookbook)                                     */
/* ------------------------------------------------------------------ */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function highpass(fc: number, fs: number, q = 0.7071): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const c = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + c) / 2) / a0,
    b1: (-(1 + c)) / a0,
    b2: ((1 + c) / 2) / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function lowpass(fc: number, fs: number, q = 0.7071): BiquadCoeffs {
  const w0 = (2 * Math.PI * fc) / fs;
  const c = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - c) / 2) / a0,
    b1: (1 - c) / a0,
    b2: ((1 - c) / 2) / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function notch(f0: number, fs: number, q = 30): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const c = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: 1 / a0, b1: (-2 * c) / a0, b2: 1 / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0 };
}

/** Stateful direct-form-II biquad, suitable for streaming samples. */
export class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private readonly c: BiquadCoeffs) {}
  process(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + this.z1;
    this.z1 = b1 * x - a1 * y + this.z2;
    this.z2 = b2 * x - a2 * y;
    return y;
  }
  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }
}

export class FilterChain {
  private readonly stages: Biquad[];
  constructor(coeffs: BiquadCoeffs[]) {
    this.stages = coeffs.map((c) => new Biquad(c));
  }
  process(x: number): number {
    let y = x;
    for (const s of this.stages) y = s.process(y);
    return y;
  }
  reset() {
    for (const s of this.stages) s.reset();
  }
}

export function makeEegFilter(fs = MUSE_SAMPLE_RATE, mains: 50 | 60 = 50): FilterChain {
  return new FilterChain([highpass(0.5, fs), lowpass(45, fs), notch(mains, fs)]);
}

/** Peak-to-peak amplitude of a slice. */
export function peakToPeak(data: Float64Array, from: number, to: number): number {
  let min = Infinity;
  let max = -Infinity;
  for (let i = from; i < to; i++) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

/** Line length — a simple, robust proxy for rhythmic/spiky activity. */
export function lineLength(data: Float64Array): number {
  let sum = 0;
  for (let i = 1; i < data.length; i++) sum += Math.abs(data[i]! - data[i - 1]!);
  return sum / (data.length - 1);
}

/* ------------------------------------------------------------------ */
/* Signal quality                                                      */
/* ------------------------------------------------------------------ */

export interface SignalQuality {
  /** 0–1 overall usability of the epoch. */
  score: number;
  grade: "good" | "fair" | "poor";
  /** Fraction of samples at or beyond the plausible EEG rail (0–1). */
  clipFraction: number;
  /** Share of 30–45 Hz power — muscle/diathermy contamination (0–1). */
  emgIndex: number;
  /** Abrupt sample-to-sample steps per second — movement/cable transients. */
  jumpRate: number;
  /** Peak-to-peak amplitude of the epoch, µV. */
  amplitudeUv: number;
  /** No measurable signal — electrode off the skin. */
  flat: boolean;
  /** Human-readable causes of any quality loss. */
  reasons: string[];
}

const CLIP_UV = 350;
const JUMP_UV = 30;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Rates a filtered epoch for artefact load. Cheap enough to run every hop.
 * `emgIndex` needs the PSD of the same window.
 */
export function signalQuality(data: Float64Array, psd: Psd, fs = MUSE_SAMPLE_RATE): SignalQuality {
  const n = data.length;
  let clipped = 0;
  let jumps = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    if (Math.abs(v) >= CLIP_UV) clipped++;
    if (i > 0 && Math.abs(v - data[i - 1]!) > JUMP_UV) jumps++;
  }
  const amplitudeUv = n ? max - min : 0;
  const clipFraction = n ? clipped / n : 0;
  const jumpRate = n ? jumps / (n / fs) : 0;

  const total =
    bandPower(psd, 0.5, 4) +
    bandPower(psd, 4, 8) +
    bandPower(psd, 8, 13) +
    bandPower(psd, 13, 30) +
    bandPower(psd, 30, 45);
  const emgIndex = total > 0 ? bandPower(psd, 30, 45) / total : 0;
  const flat = amplitudeUv < 0.5;

  const reasons: string[] = [];
  let penalty = 0;
  if (flat) {
    penalty = 0.95;
    reasons.push("No signal — check electrode contact");
  } else {
    const clipPen = clamp01(clipFraction * 8) * 0.5;
    const emgPen = clamp01((emgIndex - 0.15) / 0.35) * 0.35;
    const jumpPen = clamp01(jumpRate / 5) * 0.3;
    penalty = clipPen + emgPen + jumpPen;
    if (clipPen > 0.05) reasons.push("Amplitude saturating (movement or diathermy)");
    if (emgPen > 0.05) reasons.push("High-frequency muscle activity");
    if (jumpPen > 0.05) reasons.push("Step artefact — cable or electrode movement");
  }

  const score = clamp01(1 - penalty);
  return {
    score,
    grade: score >= 0.75 ? "good" : score >= 0.45 ? "fair" : "poor",
    clipFraction,
    emgIndex,
    jumpRate,
    amplitudeUv,
    flat,
    reasons,
  };
}

/**
 * Strength of the dominant autocorrelation peak between minHz and maxHz.
 * Rhythmic (seizure-like) discharges give a value near 1; noise gives ~0.
 */
export function rhythmicity(data: Float64Array, fs = MUSE_SAMPLE_RATE, minHz = 1.5, maxHz = 12): number {
  const n = data.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += data[i]!;
  mean /= n;
  let denom = 0;
  for (let i = 0; i < n; i++) denom += (data[i]! - mean) ** 2;
  if (denom <= 0) return 0;

  const minLag = Math.floor(fs / maxHz);
  const maxLag = Math.floor(fs / minHz);
  let best = 0;
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let acc = 0;
    for (let i = lag; i < n; i++) acc += (data[i]! - mean) * (data[i - lag]! - mean);
    const r = acc / denom;
    if (r > best) best = r;
  }
  return Math.max(0, Math.min(1, best));
}