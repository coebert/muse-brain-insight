import type { AlertEvidence } from "@/lib/eeg/interpret.functions";

/** Minimal per-epoch record needed to judge data completeness in a window. */
export interface CoverageEpoch {
  t: number;
  depth: number | null;
  sef95: number | null;
  sr: number | null;
  seizure: number | null;
  entropy: number | null;
  /** Number of spectral bins stored for this epoch (0 when the spectrum is missing). */
  spectrumBins: number;
}

export interface WindowCoverage {
  /** Epochs actually stored inside the window. */
  present: number;
  /** Epochs expected from the session cadence. */
  expected: number;
  /** present / expected, clamped to 0–1. */
  fraction: number;
  /** Longest run of missing time inside the window, in seconds. */
  largestGapSeconds: number;
  /** Metrics that are null or absent for most of the window. */
  missingMetrics: string[];
  /** Fraction of in-window epochs that carry no spectrum (no DSA to review). */
  spectrumMissingFraction: number;
  level: "ok" | "partial" | "insufficient";
}

export interface EvidenceCompleteness {
  total: number;
  /** Features with no value, no weight or no time window. */
  incomplete: number;
  /** Human-readable reasons, e.g. "2 features have no measured value". */
  reasons: string[];
  level: "ok" | "partial" | "insufficient";
}

/** Median spacing between stored epochs; falls back to 1 s. */
export function epochCadence(epochs: CoverageEpoch[]): number {
  if (epochs.length < 2) return 1;
  const deltas: number[] = [];
  for (let i = 1; i < epochs.length; i++) {
    const d = epochs[i]!.t - epochs[i - 1]!.t;
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return 1;
  deltas.sort((a, b) => a - b);
  return Math.max(0.1, deltas[Math.floor(deltas.length / 2)]!);
}

const METRIC_LABELS: [keyof CoverageEpoch, string][] = [
  ["depth", "depth index"],
  ["sef95", "SEF95"],
  ["sr", "suppression ratio"],
  ["seizure", "seizure score"],
  ["entropy", "entropy"],
];

/**
 * Judges how much EEG actually backs an alert window: stored epoch coverage,
 * gaps in the recording and metrics that were never written (typically because
 * signal quality gating held them back).
 */
export function assessWindowCoverage(
  epochs: CoverageEpoch[],
  start: number,
  end: number,
  cadence = epochCadence(epochs),
): WindowCoverage {
  const lo = Math.min(start, end);
  const hi = Math.max(end, lo + cadence);
  const inWindow = epochs.filter((e) => e.t >= lo - cadence / 2 && e.t <= hi + cadence / 2);
  const expected = Math.max(1, Math.round((hi - lo) / cadence) + 1);
  const present = inWindow.length;
  const fraction = Math.max(0, Math.min(1, present / expected));

  let largestGapSeconds = 0;
  if (!present) {
    largestGapSeconds = hi - lo;
  } else {
    let prev = lo;
    for (const e of inWindow) {
      largestGapSeconds = Math.max(largestGapSeconds, e.t - prev - cadence);
      prev = e.t;
    }
    largestGapSeconds = Math.max(largestGapSeconds, hi - prev - cadence);
    largestGapSeconds = Math.max(0, largestGapSeconds);
  }

  const missingMetrics: string[] = [];
  for (const [key, label] of METRIC_LABELS) {
    const have = inWindow.filter((e) => typeof e[key] === "number").length;
    if (!present || have / present < 0.5) missingMetrics.push(label);
  }
  const spectrumMissingFraction = present
    ? inWindow.filter((e) => !e.spectrumBins).length / present
    : 1;

  const level: WindowCoverage["level"] =
    fraction < 0.5 || spectrumMissingFraction > 0.5
      ? "insufficient"
      : fraction < 0.9 || missingMetrics.length > 0 || largestGapSeconds >= cadence * 2
        ? "partial"
        : "ok";

  return {
    present,
    expected,
    fraction,
    largestGapSeconds,
    missingMetrics,
    spectrumMissingFraction,
    level,
  };
}

/** Flags alert evidence that lacks values, weights or time windows. */
export function assessEvidence(evidence: AlertEvidence[]): EvidenceCompleteness {
  const total = evidence.length;
  if (!total) {
    return {
      total: 0,
      incomplete: 0,
      reasons: ["No evidence features were captured"],
      level: "insufficient",
    };
  }
  const noValue = evidence.filter((e) => !e.value || !String(e.value).trim()).length;
  const noWeight = evidence.filter((e) => !(typeof e.weight === "number") || e.weight <= 0).length;
  const noWindow = evidence.filter(
    (e) => typeof e.windowStartSeconds !== "number" && typeof e.windowEndSeconds !== "number",
  ).length;

  const reasons: string[] = [];
  if (noValue) reasons.push(`${noValue} feature${noValue === 1 ? "" : "s"} without a value`);
  if (noWeight) reasons.push(`${noWeight} without a contribution weight`);
  if (noWindow) reasons.push(`${noWindow} without a time window`);

  const incomplete = Math.max(noValue, noWeight, noWindow);
  const level: EvidenceCompleteness["level"] =
    incomplete / total > 0.5 ? "insufficient" : incomplete > 0 ? "partial" : "ok";
  return { total, incomplete, reasons, level };
}

export function worstLevel(
  a: "ok" | "partial" | "insufficient",
  b: "ok" | "partial" | "insufficient",
) {
  const order = { ok: 0, partial: 1, insufficient: 2 } as const;
  return order[a] >= order[b] ? a : b;
}
export interface SessionCoverage {
  /** Stored epochs. */
  present: number;
  /** Epochs expected across the session at the observed cadence. */
  expected: number;
  /** present / expected, clamped to 0–1. */
  fraction: number;
  /** Longest continuous stretch of missing recording, in seconds. */
  worstGapSeconds: number;
  /** Start time of the worst gap, in session seconds. */
  worstGapAtSeconds: number;
  /** Total missing recording time, in seconds. */
  missingSeconds: number;
  /** Metrics absent for more than half the session. */
  missingMetrics: string[];
  /** Fraction of stored epochs with no spectrum. */
  spectrumMissingFraction: number;
  cadenceSeconds: number;
  level: "ok" | "partial" | "insufficient";
}

/**
 * Whole-session view of data completeness: how much of the recording was
 * actually stored, where the biggest hole is, and which metrics are missing.
 */
export function assessSessionCoverage(
  epochs: CoverageEpoch[],
  durationSeconds?: number,
): SessionCoverage {
  const cadence = epochCadence(epochs);
  const sorted = [...epochs].sort((a, b) => a.t - b.t);
  const present = sorted.length;
  const start = present ? sorted[0]!.t : 0;
  const end = Math.max(present ? sorted[present - 1]!.t : 0, durationSeconds ?? 0);
  const span = Math.max(0, end - start);
  const expected = Math.max(1, Math.round(span / cadence) + 1);
  const fraction = Math.max(0, Math.min(1, present / expected));

  let worstGapSeconds = 0;
  let worstGapAtSeconds = 0;
  let missingSeconds = 0;
  let prev = start;
  for (const e of sorted) {
    const gap = e.t - prev - cadence;
    if (gap > 0) {
      missingSeconds += gap;
      if (gap > worstGapSeconds) {
        worstGapSeconds = gap;
        worstGapAtSeconds = prev + cadence;
      }
    }
    prev = e.t;
  }
  const tailGap = end - prev - cadence;
  if (tailGap > 0) {
    missingSeconds += tailGap;
    if (tailGap > worstGapSeconds) {
      worstGapSeconds = tailGap;
      worstGapAtSeconds = prev + cadence;
    }
  }

  const missingMetrics: string[] = [];
  for (const [key, label] of METRIC_LABELS) {
    const have = sorted.filter((e) => typeof e[key] === "number").length;
    if (!present || have / present < 0.5) missingMetrics.push(label);
  }
  const spectrumMissingFraction = present
    ? sorted.filter((e) => !e.spectrumBins).length / present
    : 1;

  const level: SessionCoverage["level"] =
    fraction < 0.75 || spectrumMissingFraction > 0.5
      ? "insufficient"
      : fraction < 0.95 || missingMetrics.length > 0 || worstGapSeconds >= cadence * 5
        ? "partial"
        : "ok";

  return {
    present,
    expected,
    fraction,
    worstGapSeconds,
    worstGapAtSeconds,
    missingSeconds,
    missingMetrics,
    spectrumMissingFraction,
    cadenceSeconds: cadence,
    level,
  };
}
