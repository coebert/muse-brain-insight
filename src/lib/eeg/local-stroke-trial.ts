/** Browser-local replay of the frontal prior-stroke research bundle. No participant data. */
export const STROKE_FEATURES = [
  "log_delta_alpha", "log_slow_fast", "relative_theta", "alpha_peak_band_fraction",
  "spectral_edge90_hz", "paired_slow_asymmetry", "paired_wideband_asymmetry",
  "max_regional_slow_asymmetry",
] as const;
const PAIR_NAMES = ["FP1-F7", "FP2-F8", "F3-C3", "F4-C4", "C3-P3", "C4-P4", "P3-O1", "P4-O2"];
const TARGET = "Documented prior stroke versus healthy control in resting research EEG";
const HZ = 500; // Matches one of the original research acquisition rates.
const FFT_SAMPLES = 2 * HZ;
const BINS = 58; // 1 through 29.5 Hz, in 0.5 Hz increments.
const WINDOW = 8 * HZ;

export interface FrontalCheckpoint {
  development: string;
  mean: number[];
  scale: number[];
  coef: number[];
  intercept: number;
}

export function parseStrokeCheckpoint(text: string): FrontalCheckpoint {
  if (!text.length || text.length > 16_384) throw new Error("Choose an extracted frontal model JSON file under 16 KB.");
  let model;
  try {
    model = JSON.parse(text);
  } catch {
    throw new Error("This file could not be read as JSON.");
  }
  if (
    !model || model.montage !== "frontal" || model.target !== TARGET || model.threshold !== 0.5 ||
    !["China only", "China and Spain"].includes(model.development) ||
    !Array.isArray(model.features) || model.features.length !== STROKE_FEATURES.length ||
    !STROKE_FEATURES.every((f, i) => f === model.features[i]) ||
    !Array.isArray(model.pairs) || model.pairs.length !== PAIR_NAMES.length ||
    !PAIR_NAMES.every((name, i) => {
      const pair = model.pairs[i];
      return Array.isArray(pair) && pair.length === 2 && pair[0] === name.split("-")[0] && pair[1] === name.split("-")[1];
    }) ||
    ![model.mean, model.scale, model.coef].every(v => Array.isArray(v) && v.length === STROKE_FEATURES.length && v.every(Number.isFinite)) ||
    !model.scale.every((n: number) => n > 0) || !Number.isFinite(model.intercept)
  ) {
    throw new Error("Choose china-frontal.json or pooled-frontal.json from the MindGuard stroke research package.");
  }
  return { development: model.development, mean: model.mean, scale: model.scale, coef: model.coef, intercept: model.intercept };
}

export const STROKE_FIXTURES = [
  { id: "symmetric", name: "Bilateral resting rhythm" },
  { id: "slowing", name: "Left-sided slowing" },
  { id: "flat", name: "Flat electrode" },
] as const;
export type StrokeFixture = (typeof STROKE_FIXTURES)[number]["id"];

export function makeStrokeFixture(type: StrokeFixture): [Float64Array, Float64Array] {
  const left = new Float64Array(120 * HZ);
  const right = new Float64Array(left.length);
  // Independent pseudorandom broadband background avoids identical or zero spectral bins.
  let state = 0x74d2ca19;
  function noise() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296 - 0.5) * 4;
  }
  for (let i = 0; i < left.length; i++) {
    const t = 2 * Math.PI * i / HZ;
    left[i] = (type === "slowing" ? 8 : 17) * Math.sin(9.7 * t) +
      (type === "slowing" ? 25 : 6) * Math.sin(2.1 * t + 0.4) +
      4 * Math.sin(5.3 * t) + 3 * Math.sin(17.2 * t) + noise();
    right[i] = 16 * Math.sin(10.2 * t + 0.2) + 6 * Math.sin(2.3 * t) +
      4 * Math.sin(5.6 * t) + 3 * Math.sin(16.9 * t) + noise();
    if (type === "flat") right[i] = 0;
  }
  return [left, right];
}

interface WelchBasis { cos: Float64Array[]; sin: Float64Array[] }
let basis: WelchBasis | undefined;
function welchBasis(): WelchBasis {
  if (basis) return basis;
  const cos: Float64Array[] = [];
  const sin: Float64Array[] = [];
  for (let bin = 2; bin < 60; bin++) {
    const c = new Float64Array(FFT_SAMPLES);
    const s = new Float64Array(FFT_SAMPLES);
    for (let j = 0; j < FFT_SAMPLES; j++) {
      const phase = 2 * Math.PI * j / FFT_SAMPLES;
      const hann = 0.5 - 0.5 * Math.cos(phase);
      c[j] = hann * Math.cos(bin * phase);
      s[j] = hann * Math.sin(bin * phase);
    }
    cos.push(c); sin.push(s);
  }
  return (basis = { cos, sin });
}

function windowPower(x: Float64Array): Float64Array | null {
  let sum = 0, weighted = 0, lo = Infinity, hi = -Infinity;
  const middle = (x.length - 1) / 2;
  for (let j = 0; j < x.length; j++) {
    const v = x[j];
    if (!Number.isFinite(v)) return null;
    sum += v; weighted += (j - middle) * v; lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  if (hi - lo < 1 || hi - lo > 600) return null;
  const slope = weighted * 12 / (x.length * (x.length * x.length - 1));
  const v = x.map((s, j) => s - sum / x.length - slope * (j - middle));
  const powers = new Float64Array(BINS);
  const { cos, sin } = welchBasis();
  for (let start = 0; start + FFT_SAMPLES <= x.length; start += HZ) {
    let mean = 0;
    for (let j = 0; j < FFT_SAMPLES; j++) mean += v[start + j];
    mean /= FFT_SAMPLES;
    for (let b = 0; b < BINS; b++) {
      let re = 0, im = 0;
      const c = cos[b], s = sin[b];
      for (let j = 0; j < FFT_SAMPLES; j++) {
        const sample = v[start + j] - mean;
        re += sample * c[j]; im += sample * s[j];
      }
      powers[b] += re * re + im * im;
    }
  }
  // All features are power ratios. Shared Welch PSD normalizers cancel for these non-DC bins.
  return powers;
}

function sumRange(a: Float64Array, from = 0, to = a.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i];
  return sum;
}

function measure(left: Float64Array, right: Float64Array) {
  const l = sumRange(left), r = sumRange(right);
  if (!(l > 0 && r > 0)) return null;
  const avg = left.map((v, b) => (v / l + right[b] / r) / 2);
  const delta = sumRange(avg, 0, 6), theta = sumRange(avg, 6, 14);
  const alpha = sumRange(avg, 14, 24), beta = sumRange(avg, 24);
  const sl = sumRange(left, 0, 14), sr = sumRange(right, 0, 14);
  const asym = Math.abs(sl - sr) / Math.max(sl + sr, 1e-30);
  let cumulative = 0, edge = 29.5, wide = 0;
  for (let b = 0; b < BINS; b++) {
    wide += Math.abs(left[b] - right[b]) / Math.max(left[b] + right[b], 1e-30);
    if (cumulative < 0.9 && cumulative + avg[b] >= 0.9) edge = 1 + b / 2;
    cumulative += avg[b];
  }
  const logRatio = (n: number, d: number) => Math.log(Math.max(n, 1e-12) / Math.max(d, 1e-12));
  return [logRatio(delta, alpha), logRatio(delta + theta, alpha + beta), theta,
    Math.max(...avg.slice(14, 24)), edge, asym, wide / BINS, asym];
}

export function strokeSampleFeatures(channels: [Float64Array, Float64Array]) {
  if (channels.some(x => x.length !== 120 * HZ)) throw new Error("Expected 120 seconds of paired 500 Hz frontal EEG.");
  const accepted: number[][] = [];
  for (let start = 0; start < channels[0].length; start += WINDOW) {
    const left = windowPower(channels[0].subarray(start, start + WINDOW));
    if (!left) continue;
    const right = windowPower(channels[1].subarray(start, start + WINDOW));
    const row = right && measure(left, right);
    if (row) accepted.push(row);
  }
  const good = accepted.length;
  if (good < 8) return { good, features: null };
  const features = STROKE_FEATURES.map((_, b) => {
    const sorted = accepted.map(row => row[b]).sort((a, b) => a - b);
    return (sorted[Math.floor((good - 1) / 2)] + sorted[Math.floor(good / 2)]) / 2;
  });
  return { good, features };
}

export function runStrokeTrial(model: FrontalCheckpoint, fixture: StrokeFixture) {
  const { features, good } = strokeSampleFeatures(makeStrokeFixture(fixture));
  if (!features) return { score: null, good };
  const logit = features.reduce((v, x, i) => v + model.coef[i] * ((x - model.mean[i]) / model.scale[i]), model.intercept);
  if (!Number.isFinite(logit)) throw new Error("The coefficients do not produce a finite score.");
  return { score: 1 / (1 + Math.exp(-logit)), good };
}
