import {
  MUSE_SAMPLE_RATE,
  bandPower,
  computePsd,
  lineLength,
  peakToPeak,
  rhythmicity,
  spectralEdge,
} from "./dsp";

export const EPOCH_SECONDS = 4;
export const HOP_SECONDS = 1;
export const DSA_MIN_HZ = 0.5;
export const DSA_MAX_HZ = 30;

export interface AnalysisSettings {
  /** Peak-to-peak threshold, µV, below which a 0.5 s segment counts as suppressed. */
  suppressionThresholdUv: number;
  /** Trailing window, seconds, over which the suppression ratio is reported. */
  srWindowSeconds: number;
  /** Seizure score above which an alert is raised. */
  seizureThreshold: number;
  /** Consecutive epochs above threshold required before alerting. */
  seizureEpochs: number;
}

export const DEFAULT_SETTINGS: AnalysisSettings = {
  suppressionThresholdUv: 8,
  srWindowSeconds: 60,
  seizureThreshold: 0.62,
  seizureEpochs: 3,
};

export interface BandPowers {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

export interface Epoch {
  /** Seconds since session start. */
  t: number;
  /** dB values (10·log10 µV²/Hz) for DSA_MIN_HZ..DSA_MAX_HZ. */
  spectrum: number[];
  bands: BandPowers;
  totalPower: number;
  sef95: number;
  /** Fraction of this epoch that was isoelectric (0–1). */
  epochSuppression: number;
  /** True when the epoch is predominantly suppressed. */
  isSuppressed: boolean;
  /** Suppression ratio over the trailing SR window (0–100 %). */
  suppressionRatio: number;
  seizureScore: number;
  seizureAlert: boolean;
  /** Amplitude looked implausible for EEG (movement/diathermy). */
  artifact: boolean;
  amplitudeUv: number;
}

export interface DetectedEvent {
  kind: "burst_suppression" | "seizure" | "isoelectric" | "annotation";
  severity: "info" | "warning" | "critical";
  t: number;
  duration: number;
  detail: string;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Turns a rolling window of filtered EEG into DSA columns, burst-suppression
 * metrics and a seizure likelihood score.
 */
export class EegAnalyzer {
  private readonly fs: number;
  private settings: AnalysisSettings;
  private lineLengthBaseline: number[] = [];
  private consecutiveSeizureEpochs = 0;
  private suppressionHistory: { t: number; fraction: number }[] = [];
  private activeSuppressionStart: number | null = null;
  private activeSeizureStart: number | null = null;

  /** Cumulative isoelectric time in seconds. */
  suppressionSeconds = 0;
  readonly events: DetectedEvent[] = [];

  constructor(settings: AnalysisSettings = DEFAULT_SETTINGS, fs = MUSE_SAMPLE_RATE) {
    this.settings = settings;
    this.fs = fs;
  }

  updateSettings(settings: AnalysisSettings) {
    this.settings = settings;
  }

  reset() {
    this.lineLengthBaseline = [];
    this.consecutiveSeizureEpochs = 0;
    this.suppressionHistory = [];
    this.activeSuppressionStart = null;
    this.activeSeizureStart = null;
    this.suppressionSeconds = 0;
    this.events.length = 0;
  }

  /** `window` is the most recent EPOCH_SECONDS of filtered signal, in µV. */
  analyze(window: Float64Array, t: number): Epoch {
    const psd = computePsd(window, this.fs);
    const spectrum: number[] = [];
    for (let k = 0; k < psd.freqs.length; k++) {
      const f = psd.freqs[k]!;
      if (f < DSA_MIN_HZ) continue;
      if (f > DSA_MAX_HZ) break;
      spectrum.push(10 * Math.log10(Math.max(psd.power[k]!, 1e-6)));
    }

    const bands: BandPowers = {
      delta: bandPower(psd, 0.5, 4),
      theta: bandPower(psd, 4, 8),
      alpha: bandPower(psd, 8, 13),
      beta: bandPower(psd, 13, 30),
      gamma: bandPower(psd, 30, 45),
    };
    const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma;
    const sef95 = spectralEdge(psd, 0.95);

    // --- burst suppression -------------------------------------------------
    const seg = Math.round(this.fs * 0.5);
    let suppressedSegs = 0;
    let segs = 0;
    let maxP2p = 0;
    for (let i = 0; i + seg <= window.length; i += seg) {
      const p2p = peakToPeak(window, i, i + seg);
      if (p2p > maxP2p) maxP2p = p2p;
      if (p2p < this.settings.suppressionThresholdUv) suppressedSegs++;
      segs++;
    }
    const epochSuppression = segs ? suppressedSegs / segs : 0;
    const artifact = maxP2p > 500;
    const isSuppressed = !artifact && epochSuppression >= 0.5;

    if (!artifact) {
      this.suppressionHistory.push({ t, fraction: epochSuppression });
      this.suppressionSeconds += epochSuppression * HOP_SECONDS;
    }
    const cutoff = t - this.settings.srWindowSeconds;
    while (this.suppressionHistory.length && this.suppressionHistory[0]!.t < cutoff) {
      this.suppressionHistory.shift();
    }
    const suppressionRatio = this.suppressionHistory.length
      ? (this.suppressionHistory.reduce((a, b) => a + b.fraction, 0) /
          this.suppressionHistory.length) *
        100
      : 0;

    if (isSuppressed && this.activeSuppressionStart === null) {
      this.activeSuppressionStart = t;
    } else if (!isSuppressed && this.activeSuppressionStart !== null) {
      const duration = t - this.activeSuppressionStart;
      if (duration >= 5) {
        this.events.push({
          kind: epochSuppression >= 0.98 ? "isoelectric" : "burst_suppression",
          severity: duration >= 30 ? "critical" : "warning",
          t: this.activeSuppressionStart,
          duration,
          detail: `Suppression sustained for ${duration.toFixed(0)} s (SR ${suppressionRatio.toFixed(0)} %)`,
        });
      }
      this.activeSuppressionStart = null;
    }

    // --- seizure likelihood -------------------------------------------------
    const ll = lineLength(window);
    const baseline = median(this.lineLengthBaseline) || ll;
    const llRatio = baseline > 0 ? ll / baseline : 1;
    const rhythmic = rhythmicity(window, this.fs);
    const ictalBand = bands.theta + bands.alpha + bandPower(psd, 3, 4);
    const ictalFraction = totalPower > 0 ? ictalBand / totalPower : 0;

    let seizureScore = 0;
    if (!artifact && !isSuppressed && maxP2p > this.settings.suppressionThresholdUv * 2) {
      seizureScore =
        0.45 * rhythmic +
        0.3 * Math.min(1, Math.max(0, (llRatio - 1.6) / 2.4)) +
        0.25 * Math.min(1, Math.max(0, (ictalFraction - 0.35) / 0.45));
      seizureScore = Math.min(1, seizureScore);
    }

    if (!artifact && !isSuppressed && seizureScore < 0.4) {
      this.lineLengthBaseline.push(ll);
      if (this.lineLengthBaseline.length > 300) this.lineLengthBaseline.shift();
    }

    let seizureAlert = false;
    if (seizureScore >= this.settings.seizureThreshold) {
      this.consecutiveSeizureEpochs++;
      if (this.consecutiveSeizureEpochs >= this.settings.seizureEpochs) {
        seizureAlert = true;
        if (this.activeSeizureStart === null) {
          this.activeSeizureStart = t - this.settings.seizureEpochs * HOP_SECONDS;
        }
      }
    } else {
      if (this.activeSeizureStart !== null) {
        const duration = t - this.activeSeizureStart;
        this.events.push({
          kind: "seizure",
          severity: duration >= 10 ? "critical" : "warning",
          t: this.activeSeizureStart,
          duration,
          detail: `Rhythmic ictal-appearing activity for ${duration.toFixed(0)} s (peak score ${seizureScore.toFixed(2)})`,
        });
        this.activeSeizureStart = null;
      }
      this.consecutiveSeizureEpochs = 0;
    }

    return {
      t,
      spectrum,
      bands,
      totalPower,
      sef95,
      epochSuppression,
      isSuppressed,
      suppressionRatio,
      seizureScore,
      seizureAlert,
      artifact,
      amplitudeUv: maxP2p,
    };
  }
}