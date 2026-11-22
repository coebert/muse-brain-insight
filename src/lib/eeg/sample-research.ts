import { detectCva, type CvaEpochInput } from "./cva-detector";
import { DSA_MIN_HZ, DSA_MAX_HZ } from "./analysis";
import { detrendInto, fft } from "./dsp";
import ageWeights from "./sample-age-weights.json";

export const RESEARCH_EXAMPLES = {
  age: [
    { id: "rest-alpha", label: "Prominent alpha rhythm" },
    { id: "rest-slow", label: "Slower alpha rhythm" },
    { id: "poor-signal", label: "Poor electrode contact" },
  ],
  stroke: [
    { id: "symmetric", label: "Symmetric baseline" },
    { id: "left-change", label: "Sustained left-sided change" },
    { id: "poor-signal", label: "Left electrode contact loss" },
  ],
} as const;

type Kind = keyof typeof RESEARCH_EXAMPLES;
export interface ResearchSampleResult {
  value: string;
  unit: string;
  label: string;
  description: string;
  evidence: string;
  model: string;
  montage: string;
  waveform: number[];
  sampleRate: number;
  state: "scored" | "withheld";
}

const sampleRate = 125;
const windowSize = 1000;
const twoPi = 2 * Math.PI;

// Reproduce the published research/resting-eeg-age feature extractor. Each
// 8-second window has three 500-sample, half-overlapping periodic Hann segments.
const segmentSize = 500;
const binHz = sampleRate / segmentSize;
const windowWeights = Array.from(
  { length: segmentSize },
  (_, i) => 0.5 - 0.5 * Math.cos((twoPi * i) / segmentSize),
);
const squaredWindowSum = windowWeights.reduce((sum, x) => sum + x * x, 0);
const frequencies = Array.from({ length: 121 }, (_, i) => i * binHz);
// Bluestein's transform preserves the reference model's exact 500-point bins
// while reusing the monitor's radix-2 FFT. The chirp is shared by all windows.
const fftSize = 1024;
const chirp = Array.from({ length: segmentSize }, (_, i) => {
  const phase = (Math.PI * ((i * i) % (2 * segmentSize))) / segmentSize;
  return [Math.cos(phase), Math.sin(phase)] as const;
});
const kernelReal = new Float64Array(fftSize);
const kernelImag = new Float64Array(fftSize);
chirp.forEach(([re, im], i) => {
  kernelReal[i] = re;
  kernelImag[i] = im;
  if (i > 0) {
    kernelReal[fftSize - i] = re;
    kernelImag[fftSize - i] = im;
  }
});
fft(kernelReal, kernelImag);

function ageSignal(lead: number, slower: boolean, badContact: boolean) {
  let state = 9001 + lead * 7919;
  let noise = 0;
  const phase = (lead + 1) * 0.31;
  const regionalGain = [0.65, 0.8, 1.35][Math.floor(lead / 2)]!;
  return Float64Array.from({ length: windowSize * 6 }, (_, i) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    noise = 0.7 * noise + 12 * (state / 4294967296 - 0.5);
    const a = (twoPi * i) / sampleRate;
    if (badContact && lead === 0) return 0;
    return (
      noise +
      4 * Math.sin(a * 1.75 + phase) +
      3 * Math.sin(a * 5.5 + phase * 1.2) +
      (slower ? 5 : 8) * regionalGain * Math.sin(a * (slower ? 9 : 10.5) + phase * 0.5) +
      2.2 * Math.sin(a * 16.25 + phase * 0.8) +
      1.2 * Math.sin(a * 24 + phase * 0.25)
    );
  });
}

function windowPsd(signal: Float64Array, start: number) {
  const psd = new Float64Array(frequencies.length);
  const samples = new Float64Array(segmentSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (const shift of [0, 250, 500]) {
    const offset = start + shift;
    detrendInto(signal.subarray(offset, offset + segmentSize), samples);
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < segmentSize; i++) {
      const tapered = samples[i]! * windowWeights[i]!;
      re[i] = tapered * chirp[i]![0];
      im[i] = -tapered * chirp[i]![1];
    }
    fft(re, im);
    for (let i = 0; i < fftSize; i++) {
      const ar = re[i]!;
      const ai = im[i]!;
      re[i] = ar * kernelReal[i]! - ai * kernelImag[i]!;
      // Conjugate before a second forward transform to obtain inverse magnitudes.
      im[i] = -(ar * kernelImag[i]! + ai * kernelReal[i]!);
    }
    fft(re, im);
    for (let k = 1; k < psd.length; k++) {
      const energy = (re[k]! ** 2 + im[k]! ** 2) / fftSize ** 2;
      psd[k] = psd[k]! + (2 * energy) / (3 * sampleRate * squaredWindowSum);
    }
  }
  return psd;
}

function median(values: number[]) {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

function usableWindow(signal: Float64Array, start: number) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < start + windowSize; i++) {
    const value = signal[i]!;
    if (!Number.isFinite(value)) return false;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return max - min > 1 && max - min < 350;
}

function regionFeatures(p: number[]) {
  function power(lo: number, hi: number) {
    return p.slice(lo / binHz, hi / binHz).reduce((sum, value) => sum + value, 0);
  }
  const total = power(1, 30);
  const bands = [
    [1, 4],
    [4, 8],
    [8, 13],
    [13, 20],
    [20, 30],
  ] as const;
  const fit = frequencies.filter((f) => (f >= 2 && f <= 6) || (f >= 15 && f <= 25));
  const xs = fit.map(Math.log);
  const ys = fit.map((f) => Math.log(p[f / binHz]!));
  const mean = (v: number[]) => v.reduce((sum, x) => sum + x, 0) / v.length;
  const mx = mean(xs);
  const my = mean(ys);
  const slope =
    xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i]! - my), 0) /
    xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const intercept = my - slope * mx;
  const alpha = frequencies.filter((f) => f >= 7 && f <= 13);
  const residual = alpha.map(
    (f) => (10 / Math.LN10) * (Math.log(p[f / binHz]!) - intercept - slope * Math.log(f)),
  );
  let highest = -Infinity;
  let peakHz = NaN;
  let prominence = 0;
  for (let i = 1; i < residual.length - 1; i++) {
    const peak = residual[i]!;
    if (peak <= highest || peak <= residual[i - 1]! || peak <= residual[i + 1]!) continue;
    let leftBase = peak;
    let rightBase = peak;
    for (let j = i - 1; j >= 0 && residual[j]! <= peak; j--)
      leftBase = Math.min(leftBase, residual[j]!);
    for (let j = i + 1; j < residual.length && residual[j]! <= peak; j++)
      rightBase = Math.min(rightBase, residual[j]!);
    const drop = peak - Math.max(leftBase, rightBase);
    if (drop >= 2) {
      highest = peak;
      peakHz = alpha[i]!;
      prominence = drop;
    }
  }
  return [
    ...bands.map(([lo, hi]) => Math.log(power(lo, hi) / total)),
    Math.log(total * binHz),
    slope,
    peakHz,
    prominence,
  ];
}

function ageDemo(id: string): ResearchSampleResult {
  const signals = ageWeights.montage.map((_, lead) =>
    ageSignal(lead, id === "rest-slow", id === "poor-signal"),
  );
  const starts = [0, 1, 2, 3, 4, 5]
    .map((w) => w * windowSize)
    .filter((offset) => signals.every((signal) => usableWindow(signal, offset)));
  const common = {
    label: "Estimated chronological age",
    model: "Adult resting EEG age model",
    montage: "Six bipolar derivations · trace Fp1–F7",
    evidence:
      "Reference ages 20–70. Mean absolute error was 10.0 years in Dortmund, 8.7 in Oslo and 18.6 in Athens. Physiological brain age has no independent reference here.",
    waveform: Array.from(signals[0]!.subarray(0, windowSize)),
    sampleRate,
  };
  if (starts.length < 4)
    return {
      ...common,
      state: "withheld",
      value: "Withheld",
      unit: "",
      description: `Only ${starts.length} of six windows met the six-channel signal checks. A score requires at least four.`,
    };
  const spectra = signals.map((signal) => starts.map((offset) => windowPsd(signal, offset)));
  const features = [0, 2, 4].flatMap((first) =>
    regionFeatures(
      frequencies.map(
        (_, k) =>
          (median(spectra[first]!.map((psd) => psd[k]!)) +
            median(spectra[first + 1]!.map((psd) => psd[k]!))) /
          2,
      ),
    ),
  );
  const prediction = features.reduce(
    (sum, x, i) =>
      sum +
      (ageWeights.coef[i]! *
        ((Number.isFinite(x) ? x : ageWeights.impute[i]!) - ageWeights.mean[i]!)) /
        ageWeights.scale[i]!,
    ageWeights.intercept,
  );
  return {
    ...common,
    state: "scored",
    value: prediction.toFixed(1),
    unit: "years",
    description: `The frozen model scored 48 seconds of simulated awake, eyes-closed EEG. The original reference cohort’s 90% prediction interval had a half-width of ${ageWeights.interval_half_width.toFixed(1)} years. The simulation has no true age.`,
  };
}

const strokeFrequencies = [2, 5, 10, 18, 26];
const baselineAmplitudes = [5, 4, 12, 3, 2];
const leftChangeAmplitudes = [7, 2, 1.5, 1, 0.5];

// These exact spectral lines belong to the same sinusoids as the displayed
// trace. Frequencies fall on bin centres and each 8-second epoch has whole cycles.
function lineSpectrum(amplitudes: number[]) {
  const spacing = 0.5;
  const bins = Array<number>(1 + (DSA_MAX_HZ - DSA_MIN_HZ) / spacing).fill(-120);
  strokeFrequencies.forEach((hz, i) => {
    bins[(hz - DSA_MIN_HZ) / spacing] = 10 * Math.log10(amplitudes[i]! ** 2 / (2 * spacing));
  });
  return bins;
}

function strokeDemo(id: string): ResearchSampleResult {
  const contactLoss = id === "poor-signal";
  const finalAmplitudes = contactLoss
    ? baselineAmplitudes.map((a) => a * 0.05)
    : id === "left-change"
      ? leftChangeAmplitudes
      : baselineAmplitudes;
  const baseline = lineSpectrum(baselineAmplitudes);
  const changed = lineSpectrum(finalAmplitudes);
  const epochs: CvaEpochInput[] = Array.from({ length: 34 }, (_, i) => {
    const t = i * 8;
    return {
      t,
      left: t <= 180 ? baseline : changed,
      right: baseline,
      leftSqi: t > 180 && contactLoss ? 12 : 95,
      rightSqi: 95,
      emg: 5,
    };
  });
  const report = detectCva(epochs);
  const finding = report.finding;
  const waveform = Array.from({ length: windowSize }, (_, i) =>
    strokeFrequencies.reduce(
      (sum, hz, k) => sum + finalAmplitudes[k]! * Math.sin((twoPi * hz * i) / sampleRate + 0.2 * k),
      0,
    ),
  );
  return {
    state: report.excludedBy ? "withheld" : "scored",
    value: report.excludedBy
      ? "Withheld"
      : finding
        ? finding.side === "left"
          ? "Left side"
          : "Right side"
        : "Balanced",
    label: "Change from baseline",
    unit: "",
    description: report.excludedBy
      ? "The left electrode lost contact. The monitor withheld its asymmetry finding."
      : finding
        ? `Power on the ${finding.side} fell ${finding.powerDropPercent.toFixed(0)}% from its baseline. The detector found a sustained unilateral change.`
        : "Both simulated hemispheres retained their baseline power. The detector found no sustained unilateral change.",
    model: "Bilateral EEG change detector",
    montage: "Bilateral spectra · trace left",
    evidence:
      "This rule compares each side with its own three-minute baseline. Its ability to identify imaging-confirmed stroke is unestablished.",
    waveform,
    sampleRate,
  };
}

const cache = new Map<string, ResearchSampleResult>();

export function runSampleResearch(kind: Kind, id: string): ResearchSampleResult {
  if (!RESEARCH_EXAMPLES[kind]?.some((example) => example.id === id))
    throw new Error("Unknown research sample");
  const key = kind + "/" + id;
  const cached = cache.get(key);
  if (cached) return cached;
  const result = kind === "age" ? ageDemo(id) : strokeDemo(id);
  cache.set(key, result);
  return result;
}
