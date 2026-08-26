/**
 * End-to-end: detection behaviour across a grid of key thresholds.
 *
 * Clinicians retune two knobs at the bedside — the suppression amplitude
 * threshold (with its reporting window) and the seizure score/persistence
 * pair. A safe monitor must respond to those knobs *predictably*: loosening a
 * threshold may only ever add detections, tightening it may only ever remove
 * them, and neither may change the confidence or reliability flags attached to
 * the underlying signal, which describe the EEG quality rather than the
 * operator's alarm preference.
 *
 * One scripted session (quiet anaesthetic baseline → graded low-amplitude
 * suppression → clean 3 Hz ictal run → recovery) is replayed once per grid
 * cell through the real analyzer, and the sweep asserts:
 *   - monotonicity: suppression time/ratio rise with the µV threshold; seizure
 *     alerts fall as the score threshold or the persistence requirement rises,
 *   - bounded outputs: ratios stay in 0–100 %, confidences in 0–1, no NaNs,
 *   - flag stability: per-epoch confidence and reliability verdicts are
 *     identical across every cell (thresholds gate alarms, not trust),
 *   - clinical floor: the labelled ictal run is caught at every sensitivity a
 *     preset ships, and the quiet baseline never produces an alert at any of
 *     them.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  DETECTION_PRESETS,
  EPOCH_SECONDS,
  EegAnalyzer,
  type AnalysisSettings,
  type DetectedEvent,
  type Epoch,
} from "./analysis";
import { MUSE_SAMPLE_RATE, makeEegFilter } from "./dsp";

const FS = MUSE_SAMPLE_RATE;
const EPOCH_LEN = EPOCH_SECONDS * FS;
const SESSION_SECONDS = 420;

/** Scripted spans, in seconds. */
const BASELINE = { start: 0, end: 90 };
const SUPPRESSION = { start: 120, end: 210 };
const ICTAL = { start: 260, end: 330 };
/** Half the analysis window: an episode is recognised ~2 s after it starts. */
const EDGE_LATENCY = EPOCH_SECONDS / 2;
const EDGE_TOLERANCE = 8;

/**
 * Suppression amplitude in the scripted episode. Sits between the tight and
 * loose ends of the swept grid so the sweep actually crosses the threshold.
 */
const SUPPRESSION_PP_UV = 9;

const SUPPRESSION_UV_GRID = [5, 8, 12, 16];
const SR_WINDOW_GRID = [30, 60, 120];
const SEIZURE_SCORE_GRID = [0.45, 0.62, 0.78];
const SEIZURE_EPOCH_GRID = [2, 3, 5];

const TIMEOUT = 600_000;

const rng = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff - 0.5;
  };
};

// ---------------------------------------------------------------------------
// Scripted signal
// ---------------------------------------------------------------------------

function sample(t: number, noise: () => number): number {
  if (t >= SUPPRESSION.start && t < SUPPRESSION.end) {
    // Low-amplitude, near-isoelectric trace at a known peak-to-peak size.
    const amp = SUPPRESSION_PP_UV / 2;
    return amp * Math.sin(2 * Math.PI * 1.6 * t) + 0.35 * noise();
  }
  if (t >= ICTAL.start && t < ICTAL.end) {
    const ramp = Math.min(1, (t - ICTAL.start) / 10);
    const amp = 60 * ramp;
    const phase = 2 * Math.PI * 3 * t;
    return (
      amp * Math.sin(phase) +
      0.45 * amp * Math.sin(2 * phase + 0.4) +
      0.2 * amp * Math.sin(3 * phase) +
      4 * noise()
    );
  }
  // Maintenance anaesthesia: drifting delta with waxing/waning alpha spindles.
  const drift = 0.35 * Math.sin(2 * Math.PI * 0.017 * t);
  const spindle = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.06 * t);
  return (
    26 * Math.sin(2 * Math.PI * (1.2 + drift) * t) +
    14 * Math.sin(2 * Math.PI * 2.7 * t + 1.1 * Math.sin(2 * Math.PI * 0.11 * t)) +
    13 * Math.sin(2 * Math.PI * (10.2 + 0.6 * drift) * t) * spindle +
    6 * Math.sin(2 * Math.PI * 5.9 * t) +
    16 * noise()
  );
}

/** The whole session, filtered exactly as the monitor filters it, once. */
function buildFiltered(): Float64Array {
  const noise = rng(4_211);
  const filter = makeEegFilter();
  const out = new Float64Array(SESSION_SECONDS * FS);
  for (let i = 0; i < out.length; i += 1) out[i] = filter.process(sample(i / FS, noise));
  return out;
}

const FILTERED = buildFiltered();

// ---------------------------------------------------------------------------
// One replay per grid cell
// ---------------------------------------------------------------------------

interface CellResult {
  settings: AnalysisSettings;
  epochs: Epoch[];
  events: DetectedEvent[];
  suppressionSeconds: number;
  analysedSeconds: number;
  /** Peak suppression ratio reported anywhere in the session, %. */
  peakRatio: number;
  /** Seizure alerts raised (episodes, not epochs). */
  seizureAlerts: number;
  /** First seizure alert time, or null. */
  firstSeizureT: number | null;
  suppressionEpisodes: DetectedEvent[];
  /** Per-epoch confidence and reliability fingerprint. */
  flagFingerprint: string;
  finite: boolean;
}

function replay(overrides: Partial<AnalysisSettings>): CellResult {
  const settings: AnalysisSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const analyzer = new EegAnalyzer(settings, FS);
  const epochs: Epoch[] = [];
  let finite = true;
  let peakRatio = 0;
  const flags: string[] = [];

  for (let end = EPOCH_LEN; end <= FILTERED.length; end += FS) {
    const window = FILTERED.subarray(end - EPOCH_LEN, end);
    const epoch = analyzer.analyze(Float64Array.from(window), end / FS);
    epochs.push(epoch);
    peakRatio = Math.max(peakRatio, epoch.suppressionRatio);
    if (
      !Number.isFinite(epoch.suppressionRatio) ||
      !Number.isFinite(epoch.seizureScore) ||
      !Number.isFinite(epoch.sef95)
    ) {
      finite = false;
    }
    flags.push(
      [
        epoch.quality.grade,
        epoch.artifact ? 1 : 0,
        epoch.depthReliability.level,
        epoch.confidence.spectral.toFixed(4),
        epoch.confidence.depth.toFixed(4),
      ].join(":"),
    );
  }

  const events = [...analyzer.events];
  const seizures = events.filter((e) => e.kind === "seizure");
  return {
    settings,
    epochs,
    events,
    suppressionSeconds: analyzer.suppressionSeconds,
    analysedSeconds: analyzer.analysedSeconds,
    peakRatio,
    seizureAlerts: seizures.length,
    firstSeizureT: seizures.length ? seizures[0]!.t : null,
    suppressionEpisodes: events.filter(
      (e) => e.kind === "burst_suppression" || e.kind === "isoelectric",
    ),
    flagFingerprint: flags.join("|"),
    finite,
  };
}

const inIctalSpan = (e: DetectedEvent) =>
  e.t + e.duration > ICTAL.start - EDGE_TOLERANCE &&
  e.t < ICTAL.end + EDGE_LATENCY + EDGE_TOLERANCE;

const inSuppressionSpan = (e: DetectedEvent) =>
  e.t + e.duration > SUPPRESSION.start - EDGE_TOLERANCE &&
  e.t < SUPPRESSION.end + EDGE_LATENCY + EDGE_TOLERANCE;

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

const uvSweep = SUPPRESSION_UV_GRID.map((uv) => replay({ suppressionThresholdUv: uv }));
const windowSweep = SR_WINDOW_GRID.map((w) => replay({ srWindowSeconds: w }));
const scoreSweep = SEIZURE_SCORE_GRID.map((s) => replay({ seizureThreshold: s }));
const persistenceSweep = SEIZURE_EPOCH_GRID.map((n) => replay({ seizureEpochs: n }));
const allCells = [...uvSweep, ...windowSweep, ...scoreSweep, ...persistenceSweep];

describe("threshold sweep: seizure and burst-suppression detection", () => {
  it("produces finite, in-range outputs in every grid cell", () => {
    for (const cell of allCells) {
      expect(cell.finite).toBe(true);
      expect(cell.epochs.length).toBeGreaterThan(SESSION_SECONDS - EPOCH_SECONDS - 2);
      for (const epoch of cell.epochs) {
        expect(epoch.suppressionRatio).toBeGreaterThanOrEqual(0);
        expect(epoch.suppressionRatio).toBeLessThanOrEqual(100);
        expect(epoch.epochSuppression).toBeGreaterThanOrEqual(0);
        expect(epoch.epochSuppression).toBeLessThanOrEqual(1);
        expect(epoch.seizureScore).toBeGreaterThanOrEqual(0);
        for (const value of Object.values(epoch.confidence)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
      // The suppression clock can never exceed the analysed time it counts on.
      expect(cell.suppressionSeconds).toBeLessThanOrEqual(cell.analysedSeconds + 1e-6);
    }
  }, TIMEOUT);

  it("raises suppression monotonically as the amplitude threshold loosens", () => {
    const seconds = uvSweep.map((c) => c.suppressionSeconds);
    const peaks = uvSweep.map((c) => c.peakRatio);
    for (let i = 1; i < uvSweep.length; i += 1) {
      expect(seconds[i]!).toBeGreaterThanOrEqual(seconds[i - 1]! - 1e-9);
      expect(peaks[i]!).toBeGreaterThanOrEqual(peaks[i - 1]! - 1e-9);
    }
    // The sweep genuinely straddles the scripted episode amplitude: the
    // tightest threshold misses it, the loosest catches it.
    expect(seconds[0]!).toBeLessThan(seconds[seconds.length - 1]!);
    expect(peaks[peaks.length - 1]!).toBeGreaterThan(20);
  }, TIMEOUT);

  it("keeps per-epoch suppression monotone in the threshold, epoch by epoch", () => {
    for (let i = 1; i < uvSweep.length; i += 1) {
      const tight = uvSweep[i - 1]!.epochs;
      const loose = uvSweep[i]!.epochs;
      for (let e = 0; e < tight.length; e += 1) {
        expect(loose[e]!.t).toBe(tight[e]!.t);
        // A looser µV threshold can only ever call *more* of an epoch suppressed.
        expect(loose[e]!.epochSuppression).toBeGreaterThanOrEqual(
          tight[e]!.epochSuppression - 1e-9,
        );
        if (tight[e]!.isSuppressed) expect(loose[e]!.isSuppressed).toBe(true);
      }
    }
  }, TIMEOUT);

  it("confines detected suppression to the labelled episode at every threshold", () => {
    for (const cell of uvSweep.concat(windowSweep)) {
      for (const episode of cell.suppressionEpisodes) {
        expect(inSuppressionSpan(episode)).toBe(true);
      }
    }
  }, TIMEOUT);

  it("changes only the reporting window, not the burden, across SR windows", () => {
    // The suppression clock counts isoelectric seconds; the window governs how
    // the ratio is averaged, so total suppression time must be identical.
    const base = windowSweep[0]!.suppressionSeconds;
    for (const cell of windowSweep) {
      expect(cell.suppressionSeconds).toBeCloseTo(base, 6);
      expect(cell.peakRatio).toBeLessThanOrEqual(100);
    }
    // A shorter window reaches a higher instantaneous ratio for the same episode.
    const peaks = windowSweep.map((c) => c.peakRatio);
    for (let i = 1; i < peaks.length; i += 1) {
      expect(peaks[i]!).toBeLessThanOrEqual(peaks[i - 1]! + 1e-6);
    }
  }, TIMEOUT);

  it("reduces seizure alerting monotonically as the score threshold rises", () => {
    const alerts = scoreSweep.map((c) => c.seizureAlerts);
    for (let i = 1; i < alerts.length; i += 1) {
      expect(alerts[i]!).toBeLessThanOrEqual(alerts[i - 1]!);
    }
    // Raw seizure scores are a property of the EEG, not the alarm threshold.
    const reference = scoreSweep[0]!.epochs.map((e) => e.seizureScore);
    for (const cell of scoreSweep) {
      cell.epochs.forEach((e, i) => expect(e.seizureScore).toBeCloseTo(reference[i]!, 9));
    }
  }, TIMEOUT);

  it("delays, never advances, alerting as the persistence requirement rises", () => {
    const alerts = persistenceSweep.map((c) => c.seizureAlerts);
    for (let i = 1; i < alerts.length; i += 1) {
      expect(alerts[i]!).toBeLessThanOrEqual(alerts[i - 1]!);
    }
    const onsets = persistenceSweep.map((c) => c.firstSeizureT);
    for (let i = 1; i < onsets.length; i += 1) {
      const prev = onsets[i - 1]!;
      const next = onsets[i] ?? null;
      if (next !== null && prev !== null) {
        expect(next).toBeGreaterThanOrEqual(prev - 1e-9);
        // Each extra required epoch costs at most one second of latency.
        const extra = SEIZURE_EPOCH_GRID[i]! - SEIZURE_EPOCH_GRID[i - 1]!;
        expect(next - prev).toBeLessThanOrEqual(extra + EDGE_TOLERANCE);
      }
    }
  }, TIMEOUT);

  it("keeps every seizure alert inside the labelled ictal run", () => {
    for (const cell of allCells) {
      for (const event of cell.events.filter((e) => e.kind === "seizure")) {
        expect(inIctalSpan(event)).toBe(true);
      }
      // Nothing fires during the quiet anaesthetic baseline in any cell.
      const baselineAlerts = cell.events.filter(
        (e) =>
          (e.kind === "seizure" || e.kind === "burst_suppression") &&
          e.t >= BASELINE.start &&
          e.t < BASELINE.end,
      );
      expect(baselineAlerts).toEqual([]);
    }
  }, TIMEOUT);

  it("does not let thresholds alter confidence or reliability flags", () => {
    // Confidence describes the EEG and the acquisition, so it must be identical
    // whatever alarm sensitivity the operator has dialled in.
    const fingerprint = allCells[0]!.flagFingerprint;
    for (const cell of allCells) {
      expect(cell.flagFingerprint).toBe(fingerprint);
    }
  }, TIMEOUT);

  it("detects the ictal run at every shipped preset sensitivity", () => {
    for (const preset of DETECTION_PRESETS) {
      const cell = replay(preset.settings);
      const seizures = cell.events.filter((e) => e.kind === "seizure");
      expect(seizures.length, preset.key).toBeGreaterThan(0);
      expect(seizures.every(inIctalSpan), preset.key).toBe(true);
      expect(cell.finite).toBe(true);
    }
  }, TIMEOUT);
});
