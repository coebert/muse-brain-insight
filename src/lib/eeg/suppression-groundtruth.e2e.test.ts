/**
 * End-to-end: burst-suppression numbers match the ground truth.
 *
 * Builds synthetic recordings whose suppressed and bursting stretches are
 * known exactly — laid out on the detector's own 0.5 s segment grid — across
 * a range of duty cycles from a continuously bursting trace to an isoelectric
 * one. Each recording is replayed through the real analyzer a second at a
 * time, and the reported suppression ratio and suppression time are compared
 * with the labels that generated the signal.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  EPOCH_SECONDS,
  HOP_SECONDS,
  EegAnalyzer,
  type AnalysisSettings,
} from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";

const FS = MUSE_SAMPLE_RATE;
/** The detector scores suppression on 0.5 s segments. */
const SEG_SECONDS = 0.5;
const EPOCH_SAMPLES = EPOCH_SECONDS * FS;

/** Deterministic pseudo-noise so runs reproduce across machines. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff - 0.5;
  };
}

interface Recording {
  label: string;
  signal: Float64Array;
  /** Ground-truth suppressed flag per 0.5 s segment. */
  segments: boolean[];
  seconds: number;
}

/**
 * A recording with a known suppressed duty cycle. Suppressed segments sit far
 * below the 8 µV threshold, bursts far above it, so the segment labels are
 * unambiguous ground truth rather than a borderline judgement.
 */
function makeRecording(
  label: string,
  seconds: number,
  isSuppressedSegment: (segIndex: number) => boolean,
  seed = 11,
): Recording {
  const segCount = Math.round(seconds / SEG_SECONDS);
  const segSamples = Math.round(FS * SEG_SECONDS);
  const signal = new Float64Array(seconds * FS);
  const segments: boolean[] = [];
  const rnd = noise(seed);
  for (let s = 0; s < segCount; s += 1) {
    const suppressed = isSuppressedSegment(s);
    segments.push(suppressed);
    for (let i = 0; i < segSamples; i += 1) {
      const idx = s * segSamples + i;
      const t = idx / FS;
      signal[idx] = suppressed
        ? 1.0 * rnd() // ≈2 µV peak-to-peak: well under the 8 µV threshold
        : 45 * Math.sin(2 * Math.PI * 10 * t) + 18 * Math.sin(2 * Math.PI * 2 * t) + 4 * rnd();
    }
  }
  return { label, signal, segments, seconds };
}

/** Alternating pattern: `dutyCycle` of every `periodSeconds` is suppressed. */
function dutyCycleRecording(dutyCycle: number, seconds = 300, periodSeconds = 10): Recording {
  const segsPerPeriod = periodSeconds / SEG_SECONDS;
  const suppressedSegs = Math.round(segsPerPeriod * dutyCycle);
  return makeRecording(
    `${Math.round(dutyCycle * 100)} % suppressed`,
    seconds,
    (s) => s % segsPerPeriod < suppressedSegs,
  );
}

interface Replayed {
  /** Reported suppression ratio at each analyzer tick, keyed by time. */
  ratios: { t: number; sr: number }[];
  suppressionSeconds: number;
  /** Ground-truth suppression ratio for the same trailing window, per tick. */
  truthRatios: { t: number; sr: number }[];
  truthSuppressionSeconds: number;
}

/** Replays a recording second by second and computes matching ground truth. */
function replay(rec: Recording, settings: AnalysisSettings = DEFAULT_SETTINGS): Replayed {
  const analyzer = new EegAnalyzer(settings, FS);
  const ratios: { t: number; sr: number }[] = [];
  const truthRatios: { t: number; sr: number }[] = [];
  const epochFractions: { t: number; fraction: number }[] = [];

  const segsPerEpoch = EPOCH_SECONDS / SEG_SECONDS;
  for (let start = 0; start + EPOCH_SAMPLES <= rec.signal.length; start += FS * HOP_SECONDS) {
    const t = (start + EPOCH_SAMPLES) / FS;
    const epoch = analyzer.analyze(Float64Array.from(rec.signal.subarray(start, start + EPOCH_SAMPLES)), t);
    ratios.push({ t, sr: epoch.suppressionRatio });

    // Ground truth for this epoch: the fraction of its segments that were
    // generated as suppressed.
    const firstSeg = Math.round(start / FS / SEG_SECONDS);
    let suppressed = 0;
    for (let s = firstSeg; s < firstSeg + segsPerEpoch; s += 1) if (rec.segments[s]) suppressed += 1;
    epochFractions.push({ t, fraction: suppressed / segsPerEpoch });

    const cutoff = t - settings.srWindowSeconds;
    const window = epochFractions.filter((e) => e.t >= cutoff);
    truthRatios.push({
      t,
      sr: (window.reduce((a, b) => a + b.fraction, 0) / window.length) * 100,
    });
  }

  return {
    ratios,
    suppressionSeconds: analyzer.suppressionSeconds,
    truthRatios,
    truthSuppressionSeconds: epochFractions.reduce((a, b) => a + b.fraction, 0) * HOP_SECONDS,
  };
}

const DUTY_CYCLES = [0, 0.1, 0.25, 0.4, 0.5, 0.75, 0.9, 1];

describe("burst-suppression ratio and time match ground-truth labels", () => {
  const TIMEOUT = 60_000;

  it.each(DUTY_CYCLES)("reports the true suppression ratio at %s duty cycle", (duty) => {
    const rec = dutyCycleRecording(duty);
    const { ratios, truthRatios } = replay(rec);

    // Once the trailing window has filled, the reported ratio must track the
    // labelled duty cycle to within a segment's worth of rounding.
    const settled = ratios.filter((r) => r.t >= DEFAULT_SETTINGS.srWindowSeconds + EPOCH_SECONDS);
    expect(settled.length).toBeGreaterThan(60);
    for (const point of settled) {
      const truth = truthRatios.find((r) => r.t === point.t)!.sr;
      expect(Math.abs(point.sr - truth), `SR at t=${point.t}s`).toBeLessThan(1.5);
      expect(Math.abs(point.sr - duty * 100), `SR vs duty at t=${point.t}s`).toBeLessThan(3);
    }
  }, TIMEOUT);

  it.each(DUTY_CYCLES)("accumulates the true suppression time at %s duty cycle", (duty) => {
    const rec = dutyCycleRecording(duty);
    const { suppressionSeconds, truthSuppressionSeconds } = replay(rec);

    expect(suppressionSeconds).toBeCloseTo(truthSuppressionSeconds, 0);
    // And the total is the duty cycle applied to the analysed span.
    const analysedSeconds = rec.seconds - EPOCH_SECONDS + HOP_SECONDS;
    expect(Math.abs(suppressionSeconds - duty * analysedSeconds)).toBeLessThan(
      Math.max(2, analysedSeconds * 0.03),
    );
  }, TIMEOUT);

  it("reports zero on a continuously bursting recording", () => {
    const { ratios, suppressionSeconds } = replay(dutyCycleRecording(0, 180));
    expect(Math.max(...ratios.map((r) => r.sr))).toBe(0);
    expect(suppressionSeconds).toBe(0);
  }, TIMEOUT);

  it("reports a full burden on an isoelectric recording", () => {
    const rec = dutyCycleRecording(1, 180);
    const { ratios, suppressionSeconds } = replay(rec);
    const settled = ratios.filter((r) => r.t >= DEFAULT_SETTINGS.srWindowSeconds + EPOCH_SECONDS);
    for (const point of settled) expect(point.sr).toBeCloseTo(100, 5);
    expect(suppressionSeconds).toBeCloseTo(rec.seconds - EPOCH_SECONDS + HOP_SECONDS, 0);
  }, TIMEOUT);

  it("tracks a duty cycle that changes part-way through the case", () => {
    // 150 s at 20 % suppression, then 150 s at 70 %.
    const segsPerPeriod = 10 / SEG_SECONDS;
    const rec = makeRecording("stepped burden", 300, (s) => {
      const duty = s * SEG_SECONDS < 150 ? 0.2 : 0.7;
      return s % segsPerPeriod < Math.round(segsPerPeriod * duty);
    });
    const { ratios } = replay(rec);

    const before = ratios.find((r) => r.t === 145)!.sr;
    const after = ratios.find((r) => r.t === 295)!.sr;
    expect(Math.abs(before - 20)).toBeLessThan(3);
    expect(Math.abs(after - 70)).toBeLessThan(3);
    // The trailing window means the rise is gradual, never a step change.
    const rising = ratios.filter((r) => r.t > 154 && r.t <= 214);
    for (let i = 1; i < rising.length; i += 1) {
      expect(rising[i]!.sr - rising[i - 1]!.sr).toBeLessThan(4);
    }
  }, TIMEOUT);

  it("rolls old suppression out of the ratio window but keeps the total time", () => {
    // Suppression only in the first 60 s, then continuous bursting.
    const rec = makeRecording("early suppression only", 240, (s) => s * SEG_SECONDS < 60);
    const { ratios, suppressionSeconds } = replay(rec);

    const peak = Math.max(...ratios.map((r) => r.sr));
    expect(peak).toBeGreaterThan(90);
    // Well past the trailing window, the ratio has returned to zero...
    expect(ratios.at(-1)!.sr).toBe(0);
    // ...while the cumulative suppression time still records those seconds.
    expect(suppressionSeconds).toBeCloseTo(60 - EPOCH_SECONDS + HOP_SECONDS, 0);
  }, TIMEOUT);

  it("does not count a flat, disconnected electrode as suppression", () => {
    // A dead-flat trace with no bursts at all is an artefact, not a brain.
    const rec = makeRecording("electrode off", 180, () => true, 3);
    rec.signal.fill(0);
    const { ratios, suppressionSeconds } = replay(rec);
    expect(Math.max(...ratios.map((r) => r.sr))).toBe(0);
    expect(suppressionSeconds).toBe(0);
  }, TIMEOUT);

  it("respects a changed suppression threshold and ratio window", () => {
    const rec = dutyCycleRecording(0.5, 240);
    const wide = replay(rec, { ...DEFAULT_SETTINGS, srWindowSeconds: 120 });
    const narrow = replay(rec, { ...DEFAULT_SETTINGS, srWindowSeconds: 30 });
    // Both settle on the same true burden; the wider window is just smoother.
    expect(Math.abs(wide.ratios.at(-1)!.sr - 50)).toBeLessThan(3);
    expect(Math.abs(narrow.ratios.at(-1)!.sr - 50)).toBeLessThan(6);
    expect(wide.suppressionSeconds).toBeCloseTo(narrow.suppressionSeconds, 6);
  }, TIMEOUT);
});
