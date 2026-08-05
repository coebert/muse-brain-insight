/**
 * Model confidence, confidence intervals and contributing factors for the three
 * headline assessments (spectral, burst suppression, seizure risk).
 *
 * Every number the monitor shows is an estimate from a short, noisy window of
 * frontal EEG. This module turns each of those point estimates into an interval
 * plus an auditable list of the factors that widened or narrowed it, so the
 * clinician can see *why* the monitor is (or is not) sure.
 *
 * Pure functions — no I/O, no React — so they can be unit-tested directly.
 */
import type { Epoch } from "@/lib/eeg/analysis";

/** Seconds between epoch updates (matches the analyser hop). */
const HOP_SECONDS = 1;

export type ConfidenceBand = "high" | "moderate" | "low";

export interface ConfidenceInterval {
  low: number;
  high: number;
  /** Nominal coverage, e.g. 0.95. */
  level: number;
  /** How the interval was derived, for the audit trail. */
  method: string;
}

/** One driver of an assessment, signed by whether it helps or hurts certainty. */
export interface ContributingFactor {
  key: string;
  label: string;
  /** Measured value, already formatted. */
  value: string;
  /**
   * −1 … +1. Positive = supports/tightens the estimate, negative = weakens or
   * widens it. Magnitude drives the bar length in the UI.
   */
  impact: number;
  /** Plain-language reason this factor matters. */
  meaning: string;
}

export interface AssessmentUncertainty {
  key: "spectral" | "suppression" | "seizure";
  label: string;
  /** Formatted point estimate. */
  value: string;
  unit: string;
  /** Numeric point estimate, or null when there is no usable data yet. */
  point: number | null;
  interval: ConfidenceInterval | null;
  /** 0–1 model confidence in this assessment. */
  confidence: number;
  band: ConfidenceBand;
  /** Seconds of EEG the estimate is based on. */
  windowSeconds: number;
  /** Number of usable epochs behind the estimate. */
  samples: number;
  factors: ContributingFactor[];
  /** One-line summary of the estimate and its spread. */
  summary: string;
  caveats: string[];
}

export interface UncertaintyReport {
  spectral: AssessmentUncertainty;
  suppression: AssessmentUncertainty;
  seizure: AssessmentUncertainty;
}

export interface UncertaintyOptions {
  /** Trailing suppression-ratio window in seconds. */
  srWindowSeconds: number;
  /** Seizure detector threshold currently in force (0–1). */
  seizureThreshold: number;
  /** Analysis window used for the spectral/seizure spread, seconds. */
  trendSeconds?: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function confidenceBand(c: number): ConfidenceBand {
  return c >= 0.75 ? "high" : c >= 0.45 ? "moderate" : "low";
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function sd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const v = values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1);
  return Math.sqrt(v);
}

/**
 * Consecutive EEG epochs are strongly autocorrelated, so the raw count badly
 * overstates the information available. A conservative lag-1 correction gives
 * an effective sample size for the standard error.
 */
function effectiveN(values: number[]): number {
  const n = values.length;
  if (n < 3) return Math.max(1, n);
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]! - m;
    den += d * d;
    if (i > 0) num += d * (values[i - 1]! - m);
  }
  const r1 = den > 0 ? Math.max(0, Math.min(0.95, num / den)) : 0;
  return Math.max(1, (n * (1 - r1)) / (1 + r1));
}

/**
 * Low confidence means the point estimate itself may be biased by artefact, not
 * merely noisy, so the sampling interval is inflated before display.
 */
function widenForConfidence(confidence: number): number {
  return 1 + 1.5 * (1 - clamp01(confidence));
}

/** Wilson score interval — correct for proportions near 0 % or 100 %. */
export function wilsonInterval(p: number, n: number, z = 1.96): { low: number; high: number } {
  const safeN = Math.max(1, n);
  const prop = clamp01(p);
  const denom = 1 + (z * z) / safeN;
  const centre = prop + (z * z) / (2 * safeN);
  const spread = z * Math.sqrt((prop * (1 - prop)) / safeN + (z * z) / (4 * safeN * safeN));
  return {
    low: clamp01((centre - spread) / denom),
    high: clamp01((centre + spread) / denom),
  };
}

function recent(epochs: Epoch[], seconds: number): Epoch[] {
  if (!epochs.length) return [];
  const last = epochs[epochs.length - 1]!;
  const cutoff = last.t - seconds;
  return epochs.filter((e) => e.t >= cutoff);
}

function emptyAssessment(
  key: AssessmentUncertainty["key"],
  label: string,
  unit: string,
  windowSeconds: number,
): AssessmentUncertainty {
  return {
    key,
    label,
    value: "—",
    unit,
    point: null,
    interval: null,
    confidence: 0,
    band: "low",
    windowSeconds,
    samples: 0,
    factors: [],
    summary: "Waiting for enough clean EEG to estimate this parameter.",
    caveats: ["No usable epochs yet — start monitoring and check electrode contact."],
  };
}

/**
 * Builds confidence intervals and contributing-factor breakdowns for the
 * spectral, burst-suppression and seizure-risk assessments from the live epoch
 * buffer.
 */
export function computeUncertainty(
  epochs: Epoch[],
  options: UncertaintyOptions,
): UncertaintyReport {
  const trendSeconds = options.trendSeconds ?? 60;
  return {
    spectral: spectralUncertainty(epochs, trendSeconds),
    suppression: suppressionUncertainty(epochs, options.srWindowSeconds),
    seizure: seizureUncertainty(epochs, trendSeconds, options.seizureThreshold),
  };
}

// --- spectral (SEF95) -------------------------------------------------------

function spectralUncertainty(epochs: Epoch[], trendSeconds: number): AssessmentUncertainty {
  const window = recent(epochs, trendSeconds).filter((e) => !e.artifact);
  if (!window.length) return emptyAssessment("spectral", "Spectral edge 95", "Hz", trendSeconds);

  const values = window.map((e) => e.sef95);
  const point = mean(values);
  const spread = sd(values);
  const nEff = effectiveN(values);
  const latest = window[window.length - 1]!;
  const confidence = clamp01(latest.confidence.spectral);
  const se = spread / Math.sqrt(nEff);
  const half = 1.96 * se * widenForConfidence(confidence);
  const quality = mean(window.map((e) => e.quality.score));
  const emg = mean(window.map((e) => e.quality.emgIndex));
  const artefactShare =
    1 - window.length / Math.max(1, recent(epochs, trendSeconds).length || window.length);

  const factors: ContributingFactor[] = [
    {
      key: "quality",
      label: "Electrode signal quality",
      value: `${(quality * 100).toFixed(0)} %`,
      impact: quality * 2 - 1,
      meaning:
        "Contact impedance and baseline stability across the window. Poor contact flattens and distorts the spectrum, shifting the spectral edge.",
    },
    {
      key: "emg",
      label: "EMG / muscle contamination",
      value: `${(emg * 100).toFixed(0)} % of power`,
      impact: -clamp01((emg - 0.1) / 0.4),
      meaning:
        "Frontalis and temporalis activity adds broadband high-frequency power, pushing SEF95 falsely upward.",
    },
    {
      key: "stability",
      label: "Epoch-to-epoch stability",
      value: `± ${spread.toFixed(1)} Hz SD`,
      impact: 1 - clamp01(spread / 4),
      meaning:
        "A stationary spectrum gives a tight interval; rapid swings mean the single displayed number is only a snapshot.",
    },
    {
      key: "samples",
      label: "Clean epochs in window",
      value: `${window.length} (${nEff.toFixed(1)} effective)`,
      impact: clamp01(nEff / 12) * 2 - 1,
      meaning:
        "Consecutive epochs are autocorrelated, so the effective sample size — not the raw count — sets the interval width.",
    },
  ];

  const caveats: string[] = [];
  if (artefactShare > 0.2) {
    caveats.push(
      `${(artefactShare * 100).toFixed(0)} % of epochs in this window were rejected as artefact.`,
    );
  }
  if (emg > 0.3) caveats.push("High EMG — SEF95 and entropy are biased upward.");
  if (confidence < 0.45) caveats.push("Low model confidence — treat the trend, not the number.");
  caveats.push("Frontal montage only: SEF95 reflects frontal cortex, not global brain state.");

  return {
    key: "spectral",
    label: "Spectral edge 95",
    unit: "Hz",
    value: point.toFixed(1),
    point,
    interval: {
      low: Math.max(0, point - half),
      high: point + half,
      level: 0.95,
      method: "Normal-approximation interval on the windowed mean, autocorrelation-corrected",
    },
    confidence,
    band: confidenceBand(confidence),
    windowSeconds: trendSeconds,
    samples: window.length,
    factors,
    summary:
      `SEF95 ${point.toFixed(1)} Hz (95 % CI ${Math.max(0, point - half).toFixed(1)}–${(point + half).toFixed(1)} Hz) ` +
      `over the last ${trendSeconds} s of clean EEG.`,
    caveats,
  };
}

// --- burst suppression ------------------------------------------------------

function suppressionUncertainty(epochs: Epoch[], srWindowSeconds: number): AssessmentUncertainty {
  const all = recent(epochs, srWindowSeconds);
  const window = all.filter((e) => !e.artifact);
  if (!window.length) {
    return emptyAssessment("suppression", "Suppression ratio", "%", srWindowSeconds);
  }

  const fractions = window.map((e) => e.epochSuppression);
  const p = mean(fractions);
  const nEff = effectiveN(fractions);
  const latest = window[window.length - 1]!;
  const confidence = clamp01(latest.confidence.suppression);
  const raw = wilsonInterval(p, nEff);
  const widen = widenForConfidence(confidence);
  const low = clamp01(p - (p - raw.low) * widen);
  const high = clamp01(p + (raw.high - p) * widen);

  const fill = clamp01((window.length * HOP_SECONDS) / Math.max(1, srWindowSeconds));
  const rejected = all.length - window.length;
  const quality = mean(window.map((e) => e.quality.score));
  const amplitude = mean(window.map((e) => e.amplitudeUv));
  // Epochs sitting near the amplitude threshold flip between suppressed and
  // burst on tiny changes, so they are the main source of BSR uncertainty.
  const borderline =
    window.filter((e) => e.epochSuppression > 0.05 && e.epochSuppression < 0.95).length /
    window.length;

  const factors: ContributingFactor[] = [
    {
      key: "fill",
      label: "Window completeness",
      value: `${(fill * 100).toFixed(0)} % of ${srWindowSeconds} s`,
      impact: fill * 2 - 1,
      meaning:
        "The suppression ratio is a rolling average. A partly filled window reports a real value but with a wide interval.",
    },
    {
      key: "borderline",
      label: "Borderline (mixed) epochs",
      value: `${(borderline * 100).toFixed(0)} %`,
      impact: -borderline,
      meaning:
        "Epochs that are part-burst, part-suppressed sit close to the amplitude threshold, so small amplitude shifts move the ratio.",
    },
    {
      key: "amplitude",
      label: "Mean peak-to-peak amplitude",
      value: `${amplitude.toFixed(0)} µV`,
      impact: amplitude < 12 ? -0.4 : 0.4,
      meaning:
        "Very low amplitude can be true suppression or a detached electrode; the detector cannot distinguish them from amplitude alone.",
    },
    {
      key: "rejected",
      label: "Artefact-rejected epochs",
      value: `${rejected} of ${all.length}`,
      impact: -clamp01(rejected / Math.max(1, all.length)),
      meaning:
        "Rejected epochs are excluded from the ratio entirely, so heavy rejection makes the denominator small and the estimate unstable.",
    },
    {
      key: "quality",
      label: "Signal quality",
      value: `${(quality * 100).toFixed(0)} %`,
      impact: quality * 2 - 1,
      meaning:
        "Suppression detection is amplitude-based and therefore highly sensitive to electrode contact.",
    },
  ];

  const caveats: string[] = [];
  if (fill < 0.6) caveats.push("Window not yet full — the ratio will settle as more EEG arrives.");
  if (amplitude < 12) {
    caveats.push("Very low amplitude — confirm electrode contact before accepting deep suppression.");
  }
  if (rejected > window.length * 0.3) caveats.push("Heavy artefact rejection in this window.");
  caveats.push("Suppression thresholds are amplitude-based and not age- or drug-adjusted.");

  return {
    key: "suppression",
    label: "Suppression ratio",
    unit: "%",
    value: (p * 100).toFixed(0),
    point: p * 100,
    interval: {
      low: low * 100,
      high: high * 100,
      level: 0.95,
      method: "Wilson score interval on the suppressed-epoch proportion",
    },
    confidence,
    band: confidenceBand(confidence),
    windowSeconds: srWindowSeconds,
    samples: window.length,
    factors,
    summary:
      `SR ${(p * 100).toFixed(0)} % (95 % CI ${(low * 100).toFixed(0)}–${(high * 100).toFixed(0)} %) ` +
      `from ${window.length} clean epoch(s) in the ${srWindowSeconds} s window.`,
    caveats,
  };
}

// --- seizure risk -----------------------------------------------------------

function seizureUncertainty(
  epochs: Epoch[],
  trendSeconds: number,
  threshold: number,
): AssessmentUncertainty {
  const window = recent(epochs, trendSeconds).filter((e) => !e.artifact);
  if (!window.length) return emptyAssessment("seizure", "Seizure risk score", "", trendSeconds);

  const scores = window.map((e) => e.seizureScore);
  const point = mean(scores);
  const spread = sd(scores);
  const nEff = effectiveN(scores);
  const latest = window[window.length - 1]!;
  const confidence = clamp01(latest.confidence.seizure);
  const half = 1.96 * (spread / Math.sqrt(nEff)) * widenForConfidence(confidence);
  const low = clamp01(point - half);
  const high = clamp01(point + half);

  const emg = Math.max(...window.map((e) => e.quality.emgIndex));
  const quality = mean(window.map((e) => e.quality.score));
  const persistence = window.filter((e) => e.seizureScore >= threshold).length / window.length;
  // Rhythmic ictal patterns concentrate power in 3–13 Hz (theta + alpha).
  const ictalShare = mean(
    window.map((e) => {
      const total =
        e.bands.delta + e.bands.theta + e.bands.alpha + e.bands.beta + e.bands.gamma || 1;
      return (e.bands.theta + e.bands.alpha) / total;
    }),
  );

  const factors: ContributingFactor[] = [
    {
      key: "level",
      label: "Score vs threshold",
      value: `${point.toFixed(2)} vs ${threshold.toFixed(2)}`,
      impact: clamp01((point - threshold) / Math.max(0.05, threshold)) * 2 - 1,
      meaning:
        "How far the mean detector score sits from the alerting threshold currently in force for this mode.",
    },
    {
      key: "persistence",
      label: "Epochs above threshold",
      value: `${(persistence * 100).toFixed(0)} %`,
      impact: persistence * 2 - 1,
      meaning:
        "Electrographic seizures evolve and persist. Isolated single-epoch spikes are far more often artefact.",
    },
    {
      key: "ictalBand",
      label: "Ictal-band (3–13 Hz) share",
      value: `${(ictalShare * 100).toFixed(0)} % of power`,
      impact: clamp01((ictalShare - 0.3) / 0.4) * 2 - 1,
      meaning: "Most electrographic seizures evolve within the theta–alpha range on this montage.",
    },
    {
      key: "emg",
      label: "Peak EMG contamination",
      value: `${(emg * 100).toFixed(0)} %`,
      impact: -clamp01((emg - 0.15) / 0.35),
      meaning:
        "Shivering, chewing and facial muscle activity produce rhythmic high-frequency activity that mimics discharges.",
    },
    {
      key: "quality",
      label: "Signal quality",
      value: `${(quality * 100).toFixed(0)} %`,
      impact: quality * 2 - 1,
      meaning:
        "Detector features are computed on the raw trace, so poor contact both hides seizures and creates false ones.",
    },
  ];

  const caveats: string[] = [];
  if (emg > 0.3) caveats.push("EMG present — rhythmic muscle artefact is the commonest mimic.");
  if (persistence > 0 && persistence < 0.2) {
    caveats.push("Only brief excursions above threshold — treat with caution.");
  }
  if (confidence < 0.45) caveats.push("Low confidence — verify against the raw waveform.");
  caveats.push(
    "A 4-electrode frontal montage cannot exclude focal or deep seizures; confirm with formal EEG.",
  );

  return {
    key: "seizure",
    label: "Seizure risk score",
    unit: "",
    value: point.toFixed(2),
    point,
    interval: {
      low,
      high,
      level: 0.95,
      method: "Normal-approximation interval on the windowed mean detector score",
    },
    confidence,
    band: confidenceBand(confidence),
    windowSeconds: trendSeconds,
    samples: window.length,
    factors,
    summary:
      `Mean score ${point.toFixed(2)} (95 % CI ${low.toFixed(2)}–${high.toFixed(2)}) against a ` +
      `threshold of ${threshold.toFixed(2)}; ${(persistence * 100).toFixed(0)} % of epochs above it.`,
    caveats,
  };
}
