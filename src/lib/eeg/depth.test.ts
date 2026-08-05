import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEPTH_CALIBRATION,
  DepthIndexEstimator,
  depthMixer,
  isDefaultCalibration,
  type DepthCalibration,
} from "@/lib/eeg/depth";

/** Synthetic epoch: one dominant sinusoid plus a little broadband noise. */
function tone(fs: number, seconds: number, hz: number, amplitudeUv: number): Float64Array {
  const n = Math.round(fs * seconds);
  const out = new Float64Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const noise = (seed / 2147483648 - 0.5) * 2;
    out[i] = amplitudeUv * Math.sin((2 * Math.PI * hz * i) / fs) + noise;
  }
  return out;
}

describe("depthMixer", () => {
  it("returns an index inside the 0-100 monitor scale", () => {
    for (const c2 of [-70, -50, -35, -25, -10]) {
      const { index } = depthMixer(-15, c2, -5, 0, DEFAULT_DEPTH_CALIBRATION);
      expect(index).toBeGreaterThanOrEqual(-1);
      expect(index).toBeLessThanOrEqual(101);
    }
  });

  it("drives the index down as burst suppression burden rises", () => {
    const light = depthMixer(-10, -20, -5, 0, DEFAULT_DEPTH_CALIBRATION).index;
    const deep = depthMixer(-10, -20, -5, 60, DEFAULT_DEPTH_CALIBRATION).index;
    expect(deep).toBeLessThan(light);
  });

  it("is monotone in SynchFastSlow across the general branch", () => {
    const low = depthMixer(-15, -55, -5, 0, DEFAULT_DEPTH_CALIBRATION).index;
    const mid = depthMixer(-15, -40, -5, 0, DEFAULT_DEPTH_CALIBRATION).index;
    const high = depthMixer(-15, -25, -5, 0, DEFAULT_DEPTH_CALIBRATION).index;
    expect(low).toBeLessThanOrEqual(mid + 1e-6);
    expect(mid).toBeLessThanOrEqual(high + 1e-6);
  });
});

describe("isDefaultCalibration", () => {
  it("recognises the published constants", () => {
    expect(isDefaultCalibration(DEFAULT_DEPTH_CALIBRATION)).toBe(true);
    expect(
      isDefaultCalibration(JSON.parse(JSON.stringify(DEFAULT_DEPTH_CALIBRATION))),
    ).toBe(true);
  });

  it("detects a fitted calibration", () => {
    const fitted: DepthCalibration = {
      ...DEFAULT_DEPTH_CALIBRATION,
      sedation: { ...DEFAULT_DEPTH_CALIBRATION.sedation, x50: -11 },
    };
    expect(isDefaultCalibration(fitted)).toBe(false);
  });
});

describe("DepthIndexEstimator", () => {
  const fs = 256;

  it("returns nothing while the epoch is unusable from the outset", () => {
    const est = new DepthIndexEstimator();
    const first = est.update(tone(fs, 4, 10, 30), fs, { usable: false, reasons: ["EMG"] }, 0.1);
    expect(first.index).toBeNull();
    expect(first.gateReasons.length).toBeGreaterThan(0);
  });

  it("produces an in-range index once the spectral window fills", () => {
    const est = new DepthIndexEstimator();
    let reading = est.update(tone(fs, 4, 10, 30), fs, { usable: true }, 1);
    expect(reading.index).not.toBeNull();
    for (let i = 0; i < 40; i++) {
      reading = est.update(tone(fs, 4, 10, 30), fs, { usable: true }, 1);
    }
    expect(reading.index).not.toBeNull();
    expect(reading.index!).toBeGreaterThanOrEqual(0);
    expect(reading.index!).toBeLessThanOrEqual(100);
  });

  it("holds the last value over an unusable epoch instead of inventing one", () => {
    const est = new DepthIndexEstimator();
    let reading = est.update(tone(fs, 4, 10, 30), fs, { usable: true }, 1);
    for (let i = 0; i < 40; i++) {
      reading = est.update(tone(fs, 4, 10, 30), fs, { usable: true }, 1);
    }
    const before = reading.index;
    const held = est.update(tone(fs, 4, 10, 30), fs, { usable: false, reasons: ["EMG"] }, 0.2);
    expect(held.held).toBe(true);
    expect(held.index).toBe(before);
    expect(held.heldSeconds).toBeGreaterThan(0);
  });

  it("reports a slower (deeper) spectrum below a fast one", () => {
    const run = (hz: number, amp: number) => {
      const est = new DepthIndexEstimator();
      let r = est.update(tone(fs, 4, hz, amp), fs, { usable: true }, 1);
      for (let i = 0; i < 40; i++) r = est.update(tone(fs, 4, hz, amp), fs, { usable: true }, 1);
      return r.index;
    };
    const slow = run(1.5, 60);
    const fast = run(20, 15);
    expect(slow).not.toBeNull();
    expect(fast).not.toBeNull();
    expect(slow!).toBeLessThan(fast!);
  });

  it("clears its state on reset", () => {
    const est = new DepthIndexEstimator();
    for (let i = 0; i < 40; i++) est.update(tone(fs, 4, 10, 30), fs, { usable: true }, 1);
    const settled = est.update(tone(fs, 4, 1.5, 60), fs, { usable: true }, 1).index;
    est.reset();
    // After a reset the smoother starts again from the new epoch alone, so the
    // reading jumps rather than continuing the previous trend.
    const afterReset = est.update(tone(fs, 4, 1.5, 60), fs, { usable: true }, 1).index;
    expect(afterReset).not.toBeNull();
    expect(afterReset).not.toBe(settled);
  });
});
