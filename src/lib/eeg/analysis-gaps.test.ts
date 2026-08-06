import { describe, expect, it } from "vitest";

import { EegAnalyzer, EPOCH_SECONDS, MUSE_SAMPLE_RATE } from "./analysis";

const FS = MUSE_SAMPLE_RATE;

/** Flat, isoelectric window (well under the suppression amplitude floor). */
function suppressedWindow(): Float64Array {
  return new Float64Array(Math.round(FS * EPOCH_SECONDS));
}

/** Ordinary mixed-frequency EEG at a plausible amplitude. */
function activeWindow(): Float64Array {
  const n = Math.round(FS * EPOCH_SECONDS);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    out[i] = 30 * Math.sin(2 * Math.PI * 10 * t) + 18 * Math.sin(2 * Math.PI * 3.3 * t);
  }
  return out;
}

describe("EegAnalyzer data gaps", () => {
  it("does not accrue suppression time across missing seconds", () => {
    const a = new EegAnalyzer();
    for (let t = 0; t < 20; t++) a.analyze(suppressedWindow(), t);
    const before = a.suppressionSeconds;
    // Headband drops out for two minutes, then returns.
    a.analyze(suppressedWindow(), 140);
    expect(a.excludedGapSeconds).toBeCloseTo(121, 5);
    expect(a.suppressionSeconds).toBeCloseTo(before, 5);
  });

  it("marks epochs whose window straddles a gap and excludes them", () => {
    const a = new EegAnalyzer();
    for (let t = 0; t < 10; t++) a.analyze(suppressedWindow(), t);
    const resumed = a.analyze(suppressedWindow(), 100);
    expect(resumed.gapAffected).toBe(true);
    expect(resumed.isSuppressed).toBe(false);
    expect(resumed.seizureScore).toBe(0);
    // Windows still containing pre-gap samples stay excluded.
    expect(a.analyze(suppressedWindow(), 101).gapAffected).toBe(true);
    expect(a.analyze(suppressedWindow(), 104).gapAffected).toBe(false);
  });

  it("closes a suppression episode at the gap rather than spanning it", () => {
    const a = new EegAnalyzer();
    a.analyze(activeWindow(), 0);
    for (let t = 1; t < 30; t++) a.analyze(suppressedWindow(), t);
    a.analyze(suppressedWindow(), 300);
    const episode = a.events.find(
      (e) => e.kind === "burst_suppression" || e.kind === "isoelectric",
    );
    expect(episode).toBeDefined();
    // Duration must reflect recorded EEG only, not the 270 s dropout.
    expect(episode!.duration).toBeLessThanOrEqual(30);
  });

  it("keeps the suppression ratio based only on recorded epochs", () => {
    const a = new EegAnalyzer();
    for (let t = 0; t < 30; t++) a.analyze(suppressedWindow(), t);
    const afterGap = a.analyze(activeWindow(), 400);
    // The gap contributes no zero-suppression filler epochs.
    expect(afterGap.suppressionRatio).toBeGreaterThan(90);
  });
});
