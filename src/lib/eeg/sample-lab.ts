import { DEFAULT_SETTINGS, EegAnalyzer, EPOCH_SECONDS, HOP_SECONDS, type Epoch } from "./analysis";
import { CoebisV2Estimator } from "./coebis-v2";
import { bandPower, computePsd, MUSE_SAMPLE_RATE, type Psd } from "./dsp";
import { measuredSeizureScore, measuredSuppressionRatio } from "./measured";

export const LAB_SAMPLES = [
  { id: "awake", label: "Awake-like background", description: "Mixed frequencies with stronger temporal alpha activity." },
  { id: "anaesthesia", label: "Anaesthetic-like slowing", description: "Slow activity with a superimposed frontal alpha rhythm." },
  { id: "suppression", label: "Burst suppression", description: "Bursts alternate with intervals of very low amplitude." },
  { id: "rhythmic", label: "Evolving rhythmic discharge", description: "A quiet baseline gives way to an increasingly fast, high-amplitude rhythm." },
  { id: "focal", label: "Left-sided slowing", description: "Extra slow activity appears on the left frontal and temporal leads." },
  { id: "emg", label: "Diminishing muscle artefact", description: "High-frequency interference fades halfway through while the simulated brain signal continues." },
] as const;

export type LabSampleId = (typeof LAB_SAMPLES)[number]["id"];

export interface LabRecording {
  sampleRate: number;
  durationSeconds: number;
  /** Common-reference scalp potentials in microvolts. */
  channels: { label: string; values: Float64Array }[];
}

export interface LabAnalysis {
  sampleRate: number;
  durationSeconds: number;
  traceStartSeconds: number;
  traceSeconds: number;
  traces: { label: string; values: number[] }[];
  depthIndex: number | null;
  seizureScore: number | null;
  seizureAlert: boolean;
  peakSeizureScore: number | null;
  anySeizureAlert: boolean;
  suppressionPercent: number | null;
  dominantHz: number | null;
  asymmetryPercent: number | null;
  emgBeforePercent: number | null;
  emgPowerPercent: number | null;
}

const SAMPLE_SECONDS = 80;
const LEADS = ["AF7", "AF8", "TP9", "TP10"] as const;
const TAU = 2 * Math.PI;

function noiseGenerator(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000 - 0.5;
  };
}

function makeChannel(id: LabSampleId, leadIndex: number) {
  const temporal = leadIndex >= 2;
  const left = leadIndex % 2 === 0;
  const phase = 0.23 * leadIndex;
  const noise = noiseGenerator(17001 + 2939 * leadIndex);
  const samples = new Float64Array(MUSE_SAMPLE_RATE * SAMPLE_SECONDS);
  let lowPassNoise = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / MUSE_SAMPLE_RATE;
    const angle = TAU * t;
    const random = noise();
    lowPassNoise = 0.94 * lowPassNoise + 0.06 * random;
    const background = 28 * lowPassNoise + 3 * random;
    const slow = Math.sin(1.25 * angle + phase);
    const alpha = Math.sin(10.25 * angle + phase + 0.35 * Math.sin(0.4 * angle));
    const awake = 7 * slow + (temporal ? 17 : 10) * alpha * (0.8 + 0.2 * Math.cos(0.32 * angle))
      + 6 * Math.sin(18.3 * angle + phase) + 4 * Math.sin(6.2 * angle + phase);
    let value = awake + background;
    switch (id) {
      case "anaesthesia":
        value = 42 * slow + (temporal ? 14 : 28) * alpha + 11 * Math.sin(0.7 * angle + phase) + background;
        break;
      case "suppression": {
        // Three-second bursts every seven seconds, with smooth onset and offset.
        const cycle = t % 7;
        const envelope = Math.max(0, Math.min(1, cycle / 0.18, (3 - cycle) / 0.18));
        value = 0.6 * slow + 0.4 * random + envelope * (47 * slow + 29 * alpha + 10 * Math.sin(3.25 * angle + phase) + background);
        break;
      }
      case "rhythmic": {
        const elapsed = Math.max(0, t - SAMPLE_SECONDS / 2);
        const blend = Math.min(1, elapsed / 2);
        const dischargePhase = TAU * (3 * elapsed + 0.03 * elapsed * elapsed) + phase;
        const amplitude = (60 + 1.4 * elapsed) * (temporal ? 0.8 : 1);
        const wave = Math.sin(dischargePhase) + 0.4 * Math.sin(2 * dischargePhase);
        value = (1 - blend) * (24 * slow + 8 * alpha) + blend * amplitude * wave + background;
        break;
      }
      case "focal":
        value += (left ? 32 : 2) * Math.sin(2.25 * angle + phase);
        break;
      case "emg": {
        const amplitude = Math.max(0, Math.min(1, (42 - t) / 4)) * (temporal ? 12 : 26);
        const muscle = Math.sin(37.3 * angle + phase) + 0.7 * Math.sin(53.7 * angle) + 0.6 * Math.sin(70.1 * angle);
        value += amplitude * (0.75 + 0.25 * Math.sin(0.8 * angle + phase)) * muscle;
        break;
      }
    }
    samples[i] = value;
  }
  return samples;
}

/** Generation is the only stage that receives a scenario label. */
export function generateLabSample(id: LabSampleId): LabRecording {
  return {
    sampleRate: MUSE_SAMPLE_RATE,
    durationSeconds: SAMPLE_SECONDS,
    channels: LEADS.map((label, index) => ({ label, values: makeChannel(id, index) })),
  };
}

function highFrequencyPercent(psd: Psd) {
  const total = bandPower(psd, 0.5, 80);
  return total > 0 ? 100 * bandPower(psd, 30, 80) / total : null;
}

function dominantFrequency(psd: Psd) {
  let peak = 0;
  let frequency: number | null = null;
  for (let i = 0; i < psd.freqs.length; i++) {
    const hz = psd.freqs[i]!;
    const power = psd.power[i]!;
    if (hz >= 0.5 && hz <= 30 && power > peak) {
      peak = power;
      frequency = hz;
    }
  }
  return frequency;
}

/** Score one lab recording using the same chronological windows as the monitor.
 * Keep this independent of the waveform generator. No expected outcome enters a detector.
 */
export function analyseLabRecording(recording: LabRecording): LabAnalysis {
  const { sampleRate, durationSeconds, channels } = recording;
  const left = channels.find(channel => channel.label === "AF7");
  const right = channels.find(channel => channel.label === "AF8");
  const length = durationSeconds * sampleRate;
  const epochLength = EPOCH_SECONDS * sampleRate;
  if (!left || !right || !Number.isSafeInteger(length) || length < epochLength ||
    sampleRate !== MUSE_SAMPLE_RATE || channels.some(channel => channel.values.length !== length)) {
    throw new Error("The lab recording requires complete 256 Hz frontal channels and at least four seconds of data.");
  }
  const detector = new EegAnalyzer(DEFAULT_SETTINGS, sampleRate);
  const depth = new CoebisV2Estimator();
  let finalEpoch: Epoch | undefined;
  let depthIndex: number | null = null;
  let peakSeizureScore: number | null = null;
  let anySeizureAlert = false;
  let firstPsd: Psd | undefined;
  let lastPsd: Psd | undefined;
  let offset = 0;
  for (let stop = epochLength; stop <= length; stop += HOP_SECONDS * sampleRate) {
    offset = stop - epochLength;
    const segment = left.values.subarray(offset, stop);
    lastPsd = computePsd(segment, sampleRate);
    firstPsd ??= lastPsd;
    finalEpoch = detector.analyze(segment, stop / sampleRate, lastPsd);
    depthIndex = depth.update(segment, sampleRate, HOP_SECONDS)?.index ?? null;
    const score = measuredSeizureScore(finalEpoch);
    if (score != null && !finalEpoch.artifact && !finalEpoch.gapAffected) {
      peakSeizureScore = Math.max(peakSeizureScore ?? 0, score);
      anySeizureAlert ||= finalEpoch.seizureAlert;
    }
  }
  if (!finalEpoch || !lastPsd || !firstPsd) throw new Error("No complete EEG epoch was available.");
  const traceEnd = offset + epochLength;
  const rightPsd = computePsd(right.values.subarray(offset, traceEnd), sampleRate);
  const deltaLeft = bandPower(lastPsd, 0.5, 4);
  const deltaRight = bandPower(rightPsd, 0.5, 4);
  const deltaSum = deltaLeft + deltaRight;
  const clean = !finalEpoch.artifact && !finalEpoch.gapAffected;
  return {
    sampleRate, durationSeconds, traceStartSeconds: offset / sampleRate, traceSeconds: EPOCH_SECONDS,
    traces: channels.map(({ label, values }) => ({ label, values: Array.from(values.subarray(offset, traceEnd)) })),
    depthIndex: clean ? depthIndex : null,
    seizureScore: clean ? measuredSeizureScore(finalEpoch) : null,
    seizureAlert: clean && finalEpoch.seizureAlert,
    peakSeizureScore, anySeizureAlert,
    suppressionPercent: measuredSuppressionRatio(finalEpoch),
    dominantHz: dominantFrequency(lastPsd),
    asymmetryPercent: deltaSum > 0 ? 100 * Math.abs(deltaLeft - deltaRight) / deltaSum : null,
    emgBeforePercent: highFrequencyPercent(firstPsd),
    emgPowerPercent: highFrequencyPercent(lastPsd),
  };
}

export function analyseLabSample(id: LabSampleId): LabAnalysis {
  return analyseLabRecording(generateLabSample(id));
}
