import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, EegAnalyzer, HOP_SECONDS } from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";
import { StreamIntegrityMonitor, suppressionClock } from "./stream-integrity";

const FS = MUSE_SAMPLE_RATE;
const CHANNELS = ["TP9", "AF7", "AF8", "TP10"];
const CHUNK = 12;

/** Feeds `seconds` of clean notifications, optionally injecting faults. */
function feed(
  monitor: StreamIntegrityMonitor,
  seconds: number,
  opts: { dropEvery?: number; nan?: number; spikes?: number; startAt?: number } = {},
) {
  const start = opts.startAt ?? 0;
  const frames = Math.round((seconds * FS) / CHUNK);
  let nan = opts.nan ?? 0;
  let spikes = opts.spikes ?? 0;
  for (let f = 0; f < frames; f += 1) {
    const now = start + Math.round(((f + 1) * CHUNK * 1000) / FS);
    if (opts.dropEvery && f % opts.dropEvery === 0) continue;
    for (const ch of CHANNELS) {
      const samples = new Float64Array(CHUNK).fill(10);
      if (nan > 0) {
        samples[0] = NaN;
        nan -= 1;
      }
      if (spikes > 0) {
        samples[1] = 900;
        spikes -= 1;
      }
      monitor.record(ch, samples, now);
    }
  }
  return start + frames * ((CHUNK * 1000) / FS);
}

describe("StreamIntegrityMonitor", () => {
  it("reports a healthy link when every packet arrives intact", () => {
    const m = new StreamIntegrityMonitor(FS);
    m.start(0);
    const end = feed(m, 30);
    const snap = m.snapshot(end);
    expect(snap.channels).toHaveLength(4);
    expect(snap.dropoutPercent).toBeLessThan(1);
    expect(snap.nonFinitePerThousand).toBe(0);
    expect(snap.spikesPerMinute).toBe(0);
    expect(snap.grade).toBe("good");
    expect(snap.reasons).toHaveLength(0);
  });

  it("counts dropped packets per electrode and grades the link down", () => {
    const m = new StreamIntegrityMonitor(FS);
    m.start(0);
    const end = feed(m, 60, { dropEvery: 10 }); // ~10 % of notifications missing
    const snap = m.snapshot(end);
    expect(snap.dropoutPercent).toBeGreaterThan(5);
    expect(snap.totals.droppedFrames).toBeGreaterThan(0);
    for (const c of snap.channels) expect(c.droppedFrames).toBeGreaterThan(0);
    expect(snap.grade).toBe("poor");
    expect(snap.reasons.join(" ")).toMatch(/packets/i);
  });

  it("measures NaN/Infinity and spike rates without altering the samples", () => {
    const m = new StreamIntegrityMonitor(FS);
    m.start(0);
    const samples = Float64Array.from([NaN, Infinity, 900, -900, 12, 12]);
    m.record("TP9", samples, 1000);
    const snap = m.snapshot(2000);
    expect(snap.totals.nonFinite).toBe(2);
    expect(snap.totals.spikes).toBe(2);
    // Untouched: the monitor observes, the filter chain sanitises.
    expect(Number.isNaN(samples[0]!)).toBe(true);
    expect(samples[2]).toBe(900);
    expect(snap.nonFinitePerThousand).toBeCloseTo((2 / 6) * 1000, 5);
  });

  it("keeps a rolling 60 s view that recovers after the fault clears", () => {
    const m = new StreamIntegrityMonitor(FS);
    m.start(0);
    const afterFault = feed(m, 60, { nan: 4000, spikes: 4000 });
    expect(m.snapshot(afterFault).recent.nonFinitePerThousand).toBeGreaterThan(10);
    const afterClean = feed(m, 90, { startAt: afterFault });
    const snap = m.snapshot(afterClean);
    expect(snap.recent.nonFinitePerThousand).toBe(0);
    expect(snap.recent.spikesPerMinute).toBe(0);
    // Cumulative totals still remember the episode.
    expect(snap.totals.nonFinite).toBeGreaterThan(0);
    expect(snap.grade).toBe("good");
  });

  it("resets cleanly for a new case", () => {
    const m = new StreamIntegrityMonitor(FS);
    m.start(0);
    feed(m, 20, { nan: 100 });
    m.reset(0);
    const snap = m.snapshot(1000);
    expect(snap.totals.samples).toBe(0);
    expect(snap.channels).toHaveLength(0);
  });
});

describe("suppression clock accounting", () => {
  const noise = (seed: number) => {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 0xffffffff - 0.5;
    };
  };

  /** 4 s window: suppressed, normal, or movement-artefact contaminated. */
  const window = (kind: "flat" | "eeg" | "artefact", t: number, rnd: () => number) => {
    const out = new Float64Array(4 * FS);
    for (let i = 0; i < out.length; i += 1) {
      const time = t + i / FS;
      if (kind === "flat") out[i] = 2 * rnd();
      else if (kind === "eeg")
        out[i] =
          30 * Math.sin(2 * Math.PI * 1.4 * time) +
          14 * Math.sin(2 * Math.PI * 9.7 * time) +
          8 * rnd();
      else out[i] = 1800 * Math.sin(2 * Math.PI * 0.8 * time) + 400 * rnd();
    }
    return out;
  };

  it("counts only analysed seconds and excludes artefact time", () => {
    const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
    const rnd = noise(7);
    let t = 0;
    const play = (kind: "flat" | "eeg" | "artefact", seconds: number) => {
      for (let i = 0; i < seconds; i += 1) {
        analyzer.analyze(window(kind, t, rnd), t);
        t += HOP_SECONDS;
      }
    };
    play("eeg", 20);
    play("flat", 40);
    play("artefact", 20);
    play("eeg", 20);

    const clock = suppressionClock({
      analysedSeconds: analyzer.analysedSeconds,
      suppressionSeconds: analyzer.suppressionSeconds,
      excludedArtifactSeconds: analyzer.excludedArtifactSeconds,
      excludedGapSeconds: analyzer.excludedGapEpochSeconds,
      elapsedSeconds: t,
    });

    // Every second is accounted for exactly once.
    expect(
      clock.analysedSeconds + clock.excludedArtifactSeconds + clock.excludedGapSeconds,
    ).toBeCloseTo(t, 5);
    // The artefact block is excluded, never counted as suppression.
    expect(clock.excludedArtifactSeconds).toBeGreaterThan(10);
    expect(clock.suppressionSeconds).toBeGreaterThan(20);
    expect(clock.suppressionSeconds).toBeLessThanOrEqual(clock.analysedSeconds);
    expect(clock.coverage).toBeGreaterThan(0.5);
    expect(clock.coverage).toBeLessThan(1);
    expect(clock.validOnly).toBe(true);
  });

  it("never advances the clock across a data gap", () => {
    const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
    const rnd = noise(11);
    for (let t = 0; t < 30; t += 1) analyzer.analyze(window("flat", t, rnd), t);
    const before = analyzer.suppressionSeconds;
    // 60 s of missing EEG, then the stream resumes.
    for (let t = 90; t < 100; t += 1) analyzer.analyze(window("flat", t, rnd), t);
    const clock = suppressionClock({
      analysedSeconds: analyzer.analysedSeconds,
      suppressionSeconds: analyzer.suppressionSeconds,
      excludedArtifactSeconds: analyzer.excludedArtifactSeconds,
      excludedGapSeconds: analyzer.excludedGapEpochSeconds,
      elapsedSeconds: 100,
    });
    expect(analyzer.excludedGapSeconds).toBeGreaterThan(50);
    expect(clock.excludedGapSeconds).toBeGreaterThan(0);
    // The gap itself contributed no suppression time.
    expect(clock.suppressionSeconds - before).toBeLessThan(12);
    expect(clock.analysedSeconds).toBeLessThan(45);
  });
});
