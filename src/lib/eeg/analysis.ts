import {
  MUSE_SAMPLE_RATE,
  bandPower,
  computePsd,
  lineLength,
  peakToPeak,
  rhythmicity,
  signalQuality,
  spectralEdge,
  type SignalQuality,
  type Psd,
} from "./dsp";
import { spectralEntropies, type SpectralEntropy } from "./dsp";
import { DepthIndexEstimator, type DepthReading } from "./depth";
import { DepthArtifactGate, type DepthArtifactReport } from "./artifact";
import { CompositeIndexEstimator, type CompositeReading } from "./composite";
import { buildSeizureEvidence, type SeizureEvidence } from "./seizure-evidence";
import { spansGap } from "./gaps";
import { applySefAlignment } from "./sef-drift";

export type { SignalQuality } from "./dsp";
export type { SeizureEvidence } from "./seizure-evidence";
export type { SpectralEntropy } from "./dsp";
export type { DepthArtifactReport } from "./artifact";
export type { CompositeReading } from "./composite";

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
  /** Fall in depth index over the trend window that raises an alert. */
  depthDropUnits: number;
  /** Rise in depth index over the trend window that raises an alert. */
  depthRiseUnits: number;
  /** Trend window, seconds, over which depth-index change is measured. */
  depthTrendSeconds: number;
  /** Suppression ratio, %, at which a burst-suppression burden alert fires. */
  bsrAlertPercent: number;
  /** Further rise in suppression ratio, %, that counts as worsening. */
  bsrWorseningPercent: number;
}

export const DEFAULT_SETTINGS: AnalysisSettings = {
  suppressionThresholdUv: 8,
  srWindowSeconds: 60,
  seizureThreshold: 0.62,
  seizureEpochs: 3,
  depthDropUnits: 15,
  depthRiseUnits: 15,
  depthTrendSeconds: 60,
  bsrAlertPercent: 10,
  bsrWorseningPercent: 10,
};

export type DetectionPresetKey = "anaesthesia" | "icu" | "icu_high_sensitivity" | "custom";

export interface DetectionPreset {
  key: DetectionPresetKey;
  label: string;
  description: string;
  settings: AnalysisSettings;
}

/**
 * Theatre wants few false alarms; ICU monitoring for non-convulsive status
 * wants to catch short, subtle runs even at the cost of extra review.
 */
export const DETECTION_PRESETS: DetectionPreset[] = [
  {
    key: "anaesthesia",
    label: "General anaesthesia",
    description: "Conservative — 0.62 score held for 3 s, 60 s suppression window.",
    settings: {
      suppressionThresholdUv: 8,
      srWindowSeconds: 60,
      seizureThreshold: 0.62,
      seizureEpochs: 3,
      depthDropUnits: 15,
      depthRiseUnits: 15,
      depthTrendSeconds: 60,
      bsrAlertPercent: 10,
      bsrWorseningPercent: 10,
    },
  },
  {
    key: "icu",
    label: "ICU sedation",
    description: "Balanced — 0.55 score held for 5 s, 120 s suppression window.",
    settings: {
      suppressionThresholdUv: 10,
      srWindowSeconds: 120,
      seizureThreshold: 0.55,
      seizureEpochs: 5,
      depthDropUnits: 20,
      depthRiseUnits: 20,
      depthTrendSeconds: 120,
      bsrAlertPercent: 5,
      bsrWorseningPercent: 10,
    },
  },
  {
    key: "icu_high_sensitivity",
    label: "ICU — high sensitivity",
    description: "Catches brief subtle runs (NCSE screening); expect more review alerts.",
    settings: {
      suppressionThresholdUv: 10,
      srWindowSeconds: 120,
      seizureThreshold: 0.42,
      seizureEpochs: 2,
      depthDropUnits: 15,
      depthRiseUnits: 15,
      depthTrendSeconds: 90,
      bsrAlertPercent: 3,
      bsrWorseningPercent: 5,
    },
  },
];

export function matchPreset(settings: AnalysisSettings): DetectionPresetKey {
  const hit = DETECTION_PRESETS.find(
    (p) =>
      p.settings.suppressionThresholdUv === settings.suppressionThresholdUv &&
      p.settings.srWindowSeconds === settings.srWindowSeconds &&
      Math.abs(p.settings.seizureThreshold - settings.seizureThreshold) < 1e-6 &&
      p.settings.seizureEpochs === settings.seizureEpochs &&
      p.settings.depthDropUnits === settings.depthDropUnits &&
      p.settings.depthRiseUnits === settings.depthRiseUnits &&
      p.settings.depthTrendSeconds === settings.depthTrendSeconds &&
      p.settings.bsrAlertPercent === settings.bsrAlertPercent &&
      p.settings.bsrWorseningPercent === settings.bsrWorseningPercent,
  );
  return hit?.key ?? "custom";
}

export interface BandPowers {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

/** Power ratios commonly used to track anaesthetic depth. */
export interface PowerRatios {
  /** Delta/alpha — rises with deepening anaesthesia and with encephalopathy. */
  deltaAlpha: number;
  /** Beta/alpha — rises with light anaesthesia and benzodiazepine beta. */
  betaAlpha: number;
  /** Theta/alpha — supports the ICU slowing picture. */
  thetaAlpha: number;
}

export interface Epoch {
  /** Seconds since session start. */
  t: number;
  /** dB values (10·log10 µV²/Hz) for DSA_MIN_HZ..DSA_MAX_HZ. */
  spectrum: number[];
  bands: BandPowers;
  /** Delta/alpha, beta/alpha and theta/alpha power ratios. */
  ratios: PowerRatios;
  /** Shannon / 95 % / state / response spectral entropies (0-1). */
  entropy: SpectralEntropy;
  totalPower: number;
  sef95: number;
  /**
   * SEF95 exactly as measured by the headband, before the fitted commercial
   * alignment. Refits must always pool this value, never the displayed one.
   */
  sef95Raw: number;
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
  /** Real-time artefact/quality assessment of this epoch. */
  quality: SignalQuality;
  /** 0–1 confidence in each reported metric, given quality and data maturity. */
  confidence: MetricConfidence;
  /** Real-time reliability verdict for the depth index (gating for display). */
  depthReliability: MetricReliability;
  /** OpenIBIS-style depth-of-anaesthesia index (BIS-like, uncalibrated). */
  depth: DepthReading;
  /** Artefact/EMG assessment of the depth preprocessing stage. */
  depthArtifact: DepthArtifactReport;
  /** qCON/qNOX-style composite consciousness and nociception indices. */
  composite: CompositeReading;
  /**
   * True when this epoch's window straddles a data gap (or is the gap itself).
   * Such epochs are excluded from suppression, seizure and depth analyses.
   */
  gapAffected: boolean;
}

export interface MetricConfidence {
  /** Suppression ratio / suppression time. */
  suppression: number;
  /** Seizure score and alerting. */
  seizure: number;
  /** DSA, spectral edge and band powers. */
  spectral: number;
  /** Depth-of-anaesthesia index. */
  depth: number;
}

export type ReliabilityLevel = "ok" | "degraded" | "unreliable";

/** Whether a metric should be trusted right now, and why not if it shouldn't. */
export interface MetricReliability {
  level: ReliabilityLevel;
  reliable: boolean;
  reasons: string[];
}

export interface DetectedEvent {
  kind:
    | "burst_suppression"
    | "seizure"
    | "isoelectric"
    | "annotation"
    | "signal_quality"
    | "depth_drop"
    | "depth_rise"
    | "depth_window_exit"
    | "depth_window_return"
    | "suppression_burden";
  severity: "info" | "warning" | "critical";
  t: number;
  duration: number;
  detail: string;
  /** Interpretable detector evidence — currently attached to seizure events. */
  evidence?: SeizureEvidence;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
  /** Running feature evidence for the seizure episode currently in progress. */
  private seizureRun: {
    peakScore: number;
    rhythmicity: number;
    lineLengthRatio: number;
    ictalFraction: number;
    qualitySum: number;
    epochs: number;
    maxEmg: number;
    minConfidence: number;
  } | null = null;
  private poorQualityStart: number | null = null;
  private recentQuality: number[] = [];
  private depthHistory: { t: number; value: number }[] = [];
  private lastDepthAlertT = -Infinity;
  private bsrAlerted = false;
  private lastBsrAlertValue = 0;
  private depthEstimator = new DepthIndexEstimator();
  private depthGate = new DepthArtifactGate();
  private compositeEstimator = new CompositeIndexEstimator();

  /** Last analysed epoch time, used to spot discontinuities in the stream. */
  private lastEpochT: number | null = null;
  /** Epochs at or before this time still contain pre-gap samples. */
  private gapRecoveryUntilT = -Infinity;
  /**
   * Time of the first fully valid (non gap-affected) epoch since the last data
   * gap. Episode boundaries are clamped to this so a back-dated start can never
   * reach into missing EEG.
   */
  private firstValidEpochT: number | null = null;

  /** Cumulative isoelectric time in seconds. */
  suppressionSeconds = 0;
  /** Seconds of missing EEG excluded from every analysis. */
  excludedGapSeconds = 0;
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
    this.seizureRun = null;
    this.poorQualityStart = null;
    this.recentQuality = [];
    this.depthHistory = [];
    this.lastDepthAlertT = -Infinity;
    this.bsrAlerted = false;
    this.lastBsrAlertValue = 0;
    this.depthEstimator.reset();
    this.depthGate.reset();
    this.compositeEstimator.reset();
    this.suppressionSeconds = 0;
    this.excludedGapSeconds = 0;
    this.lastEpochT = null;
    this.gapRecoveryUntilT = -Infinity;
    this.firstValidEpochT = null;
    this.events.length = 0;
  }

  /** `window` is the most recent EPOCH_SECONDS of filtered signal, in µV. */
  /**
   * `precomputed` lets the caller supply a spectrum it already has (e.g. from
   * a paired FFT), avoiding a second transform of the same window.
   */
  analyze(window: Float64Array, t: number, precomputed?: Psd): Epoch {
    // --- data-gap handling ---------------------------------------------------
    // Missing EEG must never be analysed or interpolated across: any episode in
    // progress is closed at the last good sample, and the epochs whose window
    // still straddles the gap are excluded from suppression, seizure and depth
    // computations.
    const previousT = this.lastEpochT;
    const atGapEdge = previousT != null && spansGap(previousT, t, HOP_SECONDS);
    if (atGapEdge && previousT != null) {
      this.excludedGapSeconds += t - previousT;
      this.closeRunsAtGap(previousT);
      this.gapRecoveryUntilT = t + EPOCH_SECONDS - HOP_SECONDS;
      this.firstValidEpochT = null;
    }
    const gapAffected = atGapEdge || t <= this.gapRecoveryUntilT;
    this.lastEpochT = t;
    if (!gapAffected && this.firstValidEpochT === null) this.firstValidEpochT = t;

    const psd = precomputed ?? computePsd(window, this.fs);
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
    const sef95Raw = spectralEdge(psd, 0.95);
    // Displayed SEF is mapped onto the commercial monitor's scale when a
    // paired-reading model has been fitted; entropy and every other derived
    // measure stay on the raw spectrum.
    const sef95 = applySefAlignment(sef95Raw);
    // Guard the ratios: an alpha floor keeps them finite in deep suppression
    // where alpha power approaches zero.
    const alphaFloor = Math.max(bands.alpha, totalPower * 1e-3, 1e-6);
    const ratios: PowerRatios = {
      deltaAlpha: bands.delta / alphaFloor,
      betaAlpha: bands.beta / alphaFloor,
      thetaAlpha: bands.theta / alphaFloor,
    };
    const entropy = spectralEntropies(psd, sef95Raw);

    // --- signal quality -----------------------------------------------------
    const quality = signalQuality(window, psd, this.fs);
    this.recentQuality.push(quality.score);
    if (this.recentQuality.length > 30) this.recentQuality.shift();
    const sustainedQuality =
      this.recentQuality.reduce((a, b) => a + b, 0) / this.recentQuality.length;

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
    // A flat trace is an electrode off the skin, not a suppressed brain. Gating
    // only on the composite grade let a "fair" near-flat epoch count as
    // suppression seconds, which is the one artefact that must never inflate a
    // burst-suppression burden.
    const artifact = maxP2p > 500 || quality.grade === "poor" || quality.flat;
    const isSuppressed = !artifact && !gapAffected && epochSuppression >= 0.5;

    if (!artifact && !gapAffected) {
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

    // --- burst-suppression burden alerts -----------------------------------
    // Fires once on crossing the configured suppression ratio, then again each
    // time the burden worsens by a further step.
    if (!artifact && !gapAffected) {
      if (!this.bsrAlerted && suppressionRatio >= this.settings.bsrAlertPercent) {
        this.bsrAlerted = true;
        this.lastBsrAlertValue = suppressionRatio;
        this.events.push({
          kind: "suppression_burden",
          severity: suppressionRatio >= 40 ? "critical" : "warning",
          t,
          duration: 0,
          detail: `New burst suppression — SR ${suppressionRatio.toFixed(0)} % over ${this.settings.srWindowSeconds} s`,
        });
      } else if (
        this.bsrAlerted &&
        suppressionRatio >= this.lastBsrAlertValue + this.settings.bsrWorseningPercent
      ) {
        const from = this.lastBsrAlertValue;
        this.lastBsrAlertValue = suppressionRatio;
        this.events.push({
          kind: "suppression_burden",
          severity: suppressionRatio >= 40 ? "critical" : "warning",
          t,
          duration: 0,
          detail: `Worsening burst suppression — SR ${from.toFixed(0)} % → ${suppressionRatio.toFixed(0)} %`,
        });
      } else if (this.bsrAlerted && suppressionRatio < this.settings.bsrAlertPercent * 0.5) {
        this.bsrAlerted = false;
        this.lastBsrAlertValue = 0;
      }
    }

    // --- seizure likelihood -------------------------------------------------
    const ll = lineLength(window);
    const baseline = median(this.lineLengthBaseline) || ll;
    const llRatio = baseline > 0 ? ll / baseline : 1;
    const rhythmic = rhythmicity(window, this.fs);
    const ictalBand = bands.theta + bands.alpha + bandPower(psd, 3, 4);
    const ictalFraction = totalPower > 0 ? ictalBand / totalPower : 0;

    let seizureScore = 0;
    // Muscle activity is rhythmic too. Penalising only the reported confidence
    // let a chewing or shivering artefact cross the alarm threshold and merely
    // be labelled low-confidence; the score itself has to carry the penalty.
    const emgContamination = clamp01((quality.emgIndex - 0.15) / 0.35);
    if (
      !artifact &&
      !gapAffected &&
      !isSuppressed &&
      maxP2p > this.settings.suppressionThresholdUv * 2
    ) {
      seizureScore =
        0.45 * rhythmic +
        0.3 * Math.min(1, Math.max(0, (llRatio - 1.6) / 2.4)) +
        0.25 * Math.min(1, Math.max(0, (ictalFraction - 0.35) / 0.45));
      seizureScore = Math.min(1, seizureScore) * (1 - 0.6 * emgContamination);
    }

    if (!artifact && !gapAffected && !isSuppressed && seizureScore < 0.4) {
      this.lineLengthBaseline.push(ll);
      if (this.lineLengthBaseline.length > 300) this.lineLengthBaseline.shift();
    }

    let seizureAlert = false;
    // Seizure confidence is computed here (rather than only in the confidence
    // block below) so the evidence attached to the event reflects the run.
    const seizureBaselineMaturity = clamp01(this.lineLengthBaseline.length / 60);
    const seizureEmgPenalty = emgContamination;
    const seizureConfidence = clamp01(
      quality.score *
        (0.3 + 0.7 * seizureBaselineMaturity) *
        (1 - 0.6 * seizureEmgPenalty) *
        (isSuppressed ? 0.6 : 1),
    );
    if (gapAffected) {
      // Inside (or straddling) a gap: neither start, extend nor terminate an
      // episode. The run was already closed at the last good sample by
      // closeRunsAtGap, so there is nothing to score or emit here.
    } else if (seizureScore >= this.settings.seizureThreshold) {
      this.consecutiveSeizureEpochs++;
      const run = this.seizureRun ?? {
        peakScore: 0,
        rhythmicity: 0,
        lineLengthRatio: 0,
        ictalFraction: 0,
        qualitySum: 0,
        epochs: 0,
        maxEmg: 0,
        minConfidence: 1,
      };
      run.peakScore = Math.max(run.peakScore, seizureScore);
      run.rhythmicity = Math.max(run.rhythmicity, rhythmic);
      run.lineLengthRatio = Math.max(run.lineLengthRatio, llRatio);
      run.ictalFraction = Math.max(run.ictalFraction, ictalFraction);
      run.qualitySum += quality.score;
      run.epochs += 1;
      run.maxEmg = Math.max(run.maxEmg, quality.emgIndex);
      run.minConfidence = Math.min(run.minConfidence, seizureConfidence);
      this.seizureRun = run;
      if (this.consecutiveSeizureEpochs >= this.settings.seizureEpochs) {
        seizureAlert = true;
        if (this.activeSeizureStart === null) {
          // Back-date the onset by the epochs that met threshold, but never
          // past the first valid epoch after a gap.
          const backDated = t - this.consecutiveSeizureEpochs * HOP_SECONDS;
          const floorT = this.firstValidEpochT ?? backDated;
          this.activeSeizureStart = Math.max(backDated, floorT);
        }
      }
    } else {
      if (this.activeSeizureStart !== null) {
        const duration = t - this.activeSeizureStart;
        const run = this.seizureRun;
        this.events.push({
          kind: "seizure",
          severity: duration >= 10 ? "critical" : "warning",
          t: this.activeSeizureStart,
          duration,
          detail: `Rhythmic ictal-appearing activity for ${duration.toFixed(0)} s (peak score ${(run?.peakScore ?? seizureScore).toFixed(2)})`,
          evidence: buildSeizureEvidence({
            peakScore: run?.peakScore ?? seizureScore,
            threshold: this.settings.seizureThreshold,
            epochsRequired: this.settings.seizureEpochs,
            epochsObserved: run?.epochs ?? this.consecutiveSeizureEpochs,
            rhythmicity: run?.rhythmicity ?? rhythmic,
            lineLengthRatio: run?.lineLengthRatio ?? llRatio,
            ictalFraction: run?.ictalFraction ?? ictalFraction,
            signalQuality: run && run.epochs ? run.qualitySum / run.epochs : quality.score,
            emgIndex: run?.maxEmg ?? quality.emgIndex,
            confidence: run?.minConfidence ?? seizureConfidence,
            durationSeconds: duration,
          }),
        });
        this.activeSeizureStart = null;
      }
      this.consecutiveSeizureEpochs = 0;
      this.seizureRun = null;
    }

    // --- per-metric confidence ---------------------------------------------
    const srFill = clamp01(
      this.suppressionHistory.length / Math.max(1, this.settings.srWindowSeconds / HOP_SECONDS),
    );
    const emgPenalty = seizureEmgPenalty;
    // Depth-specific preprocessing: repair bounded ocular/movement transients,
    // reject EMG-, spike- and saturation-contaminated epochs outright.
    const prep = this.depthGate.evaluate(window, psd, this.fs, quality.score);
    const depthArtifact = prep.report;
    const depth = this.depthEstimator.update(
      prep.signal,
      this.fs,
      {
        usable: depthArtifact.usable && !artifact && !gapAffected,
        reasons: gapAffected ? [...depthArtifact.reasons, "data gap"] : depthArtifact.reasons,
      },
      HOP_SECONDS,
    );

    // --- depth index change alerts ------------------------------------------
    // Only trend on ungated values so the artefact "hold" does not read as a
    // real change; a cooldown of one trend window prevents alert storms.
    if (
      !gapAffected &&
      !depth.held &&
      typeof depth.index === "number" &&
      Number.isFinite(depth.index)
    ) {
      this.depthHistory.push({ t, value: depth.index });
    }
    const depthCutoff = t - this.settings.depthTrendSeconds;
    while (this.depthHistory.length && this.depthHistory[0]!.t < depthCutoff) {
      this.depthHistory.shift();
    }
    if (
      this.depthHistory.length >= 2 &&
      t - this.lastDepthAlertT >= this.settings.depthTrendSeconds
    ) {
      const first = this.depthHistory[0]!;
      const last = this.depthHistory[this.depthHistory.length - 1]!;
      const change = last.value - first.value;
      const span = Math.max(1, last.t - first.t);
      if (change <= -this.settings.depthDropUnits) {
        this.lastDepthAlertT = t;
        this.events.push({
          kind: "depth_drop",
          severity: last.value <= 30 ? "critical" : "warning",
          t,
          duration: span,
          detail: `Depth index fell ${Math.abs(change).toFixed(0)} units in ${span.toFixed(0)} s (${first.value.toFixed(0)} → ${last.value.toFixed(0)}) — deepening`,
        });
      } else if (change >= this.settings.depthRiseUnits) {
        this.lastDepthAlertT = t;
        this.events.push({
          kind: "depth_rise",
          severity: last.value >= 80 ? "critical" : "warning",
          t,
          duration: span,
          detail: `Depth index rose ${change.toFixed(0)} units in ${span.toFixed(0)} s (${first.value.toFixed(0)} → ${last.value.toFixed(0)}) — lightening`,
        });
      }
    }

    const confidence: MetricConfidence = {
      spectral: clamp01(quality.score * (0.6 + 0.4 * sustainedQuality)),
      suppression: clamp01(quality.score * (0.35 + 0.65 * srFill) * (1 - 0.4 * emgPenalty)),
      seizure: seizureConfidence,
      // EMG in the 30–47 Hz band directly contaminates the beta ratio, so it
      // penalises the depth index harder than the plain spectral metrics; the
      // share of the 30 s window lost to the artefact gate matters just as much.
      depth: clamp01(
        quality.score *
          (0.4 + 0.6 * clamp01(this.recentQuality.length / 15)) *
          (1 - 0.7 * emgPenalty) *
          (1 - 0.6 * depth.gatedFraction) *
          (depth.held ? 0.7 : 1),
      ),
    };

    // --- qCON/qNOX-style composite indices ----------------------------------
    // --- depth reliability gating -------------------------------------------
    // The depth index is the most artefact-sensitive metric on this montage, so
    // it gets an explicit verdict rather than only a confidence bar.
    const depthReasons: string[] = [];
    if (depth.index == null) depthReasons.push("warming up — not enough clean EEG yet");
    if (quality.grade === "poor") depthReasons.push("poor electrode signal");
    if (artifact) depthReasons.push("amplitude outside physiological range");
    if (emgPenalty > 0.5) depthReasons.push("EMG contamination of the 30–47 Hz band");
    if (depth.gatedFraction > 0.3) {
      depthReasons.push(
        `${(depth.gatedFraction * 100).toFixed(0)} % of the depth window artefact-gated`,
      );
    }
    if (depth.held) {
      depthReasons.push(
        `holding last clean value for ${depth.heldSeconds.toFixed(0)} s — ${
          depth.gateReasons[0] ?? "epoch rejected"
        }`,
      );
    }
    const depthLevel: ReliabilityLevel =
      depth.index == null ||
      confidence.depth < 0.35 ||
      (depth.held && depth.heldSeconds >= 10) ||
      quality.grade === "poor"
        ? "unreliable"
        : confidence.depth < 0.6 || depthReasons.length > 0
          ? "degraded"
          : "ok";
    const depthReliability: MetricReliability = {
      level: depthLevel,
      reliable: depthLevel !== "unreliable",
      reasons: depthReasons,
    };

    // Shares the depth artefact gate: an epoch good enough for the depth index
    // is good enough for the composite, and both hold over rejected epochs.
    const composite = this.compositeEstimator.update({
      bands,
      ratios,
      entropy,
      suppressionRatio,
      usable: depthArtifact.usable && !artifact,
    });

    // Log sustained degradation so it is auditable alongside clinical events.
    if (quality.grade === "poor" && this.poorQualityStart === null) {
      this.poorQualityStart = t;
    } else if (quality.grade !== "poor" && this.poorQualityStart !== null) {
      const duration = t - this.poorQualityStart;
      if (duration >= 5) {
        this.events.push({
          kind: "signal_quality",
          severity: duration >= 30 ? "warning" : "info",
          t: this.poorQualityStart,
          duration,
          detail: `Poor signal quality for ${duration.toFixed(0)} s — metrics unreliable`,
        });
      }
      this.poorQualityStart = null;
    }

    return {
      t,
      spectrum,
      bands,
      ratios,
      entropy,
      totalPower,
      sef95,
      sef95Raw,
      epochSuppression,
      isSuppressed,
      suppressionRatio,
      seizureScore,
      seizureAlert,
      artifact,
      amplitudeUv: maxP2p,
      quality,
      confidence,
      depth,
      depthReliability,
      depthArtifact,
      composite,
      gapAffected,
    };
  }

  /**
   * Ends any suppression or seizure episode at the last sample before a gap so
   * durations never include missing time, and drops trend state that would
   * otherwise be compared across the gap.
   */
  private closeRunsAtGap(endT: number) {
    if (this.activeSuppressionStart !== null) {
      const duration = endT - this.activeSuppressionStart;
      if (duration >= 5) {
        this.events.push({
          kind: "burst_suppression",
          severity: duration >= 30 ? "critical" : "warning",
          t: this.activeSuppressionStart,
          duration,
          detail: `Suppression for ${duration.toFixed(0)} s — episode closed at a data gap`,
        });
      }
      this.activeSuppressionStart = null;
    }

    if (this.activeSeizureStart !== null) {
      const duration = endT - this.activeSeizureStart;
      const run = this.seizureRun;
      const evidence = run
        ? buildSeizureEvidence({
            peakScore: run.peakScore,
            threshold: this.settings.seizureThreshold,
            epochsRequired: this.settings.seizureEpochs,
            epochsObserved: run.epochs,
            rhythmicity: run.rhythmicity,
            lineLengthRatio: run.lineLengthRatio,
            ictalFraction: run.ictalFraction,
            signalQuality: run.epochs ? run.qualitySum / run.epochs : 0,
            emgIndex: run.maxEmg,
            confidence: run.minConfidence,
            durationSeconds: duration,
          })
        : undefined;
      this.events.push({
        kind: "seizure",
        severity: duration >= 10 ? "critical" : "warning",
        t: this.activeSeizureStart,
        duration,
        detail: `Rhythmic ictal-appearing activity for ${duration.toFixed(0)} s — episode closed at a data gap`,
        ...(evidence ? { evidence } : {}),
      });
      this.activeSeizureStart = null;
    }
    this.consecutiveSeizureEpochs = 0;
    this.seizureRun = null;
    // Depth trending and poor-quality runs must not span the gap either.
    this.depthHistory = [];
    this.poorQualityStart = null;
  }
}
