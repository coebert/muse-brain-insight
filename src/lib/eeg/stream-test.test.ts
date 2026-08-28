import { describe, expect, it } from "vitest";

import { bleRetryDelayMs, BLE_RETRY_MAX_MS } from "@/lib/eeg/ble-eeg";
import { ANALYSIS_SAMPLE_RATE } from "@/lib/eeg/device-profile";
import { analyseStreamTest, streamTestCellColor } from "@/lib/eeg/stream-test";

const fs = ANALYSIS_SAMPLE_RATE;

/** Pink-ish EEG: 1/f amplitude across a handful of narrowband components. */
function syntheticEeg(seconds: number): Float64Array {
  const n = seconds * fs;
  const out = new Float64Array(n);
  const comps = [1.5, 2.5, 4, 6, 9, 12, 18, 25];
  for (const f of comps) {
    const amp = 40 / f;
    const phase = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) out[i]! += amp * Math.sin((2 * Math.PI * f * i) / fs + phase);
  }
  for (let i = 0; i < n; i++) out[i]! += (Math.random() - 0.5) * 2;
  return out;
}

describe("analyseStreamTest", () => {
  it("passes every check on an EEG-shaped stream and builds one column per second", () => {
    const result = analyseStreamTest(syntheticEeg(6), { captureSeconds: 6 });
    expect(result.columns).toHaveLength(6);
    expect(result.freqs[0]).toBeGreaterThanOrEqual(1);
    expect(result.passed).toBe(true);
    expect(result.sef95).toBeGreaterThan(2);
    expect(result.sef95).toBeLessThan(29.5);
    expect(result.bands.delta + result.bands.theta).toBeGreaterThan(0.3);
  });

  it("fails when no samples arrive", () => {
    const result = analyseStreamTest(new Float64Array(0), { captureSeconds: 6 });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.id === "packets")?.ok).toBe(false);
    expect(result.summary).toMatch(/failed/i);
  });

  it("rejects broadband electrode noise as not EEG-shaped", () => {
    const n = 6 * fs;
    const noise = new Float64Array(n);
    for (let i = 0; i < n; i++) noise[i] = (Math.random() - 0.5) * 60;
    const result = analyseStreamTest(noise, { captureSeconds: 6 });
    expect(result.checks.find((c) => c.id === "spectrum")?.ok).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("flags a delivered rate far below the expected rate", () => {
    const result = analyseStreamTest(syntheticEeg(3), { captureSeconds: 6 });
    expect(result.checks.find((c) => c.id === "rate")?.ok).toBe(false);
  });

  it("maps power onto a colour ramp bounded by the observed range", () => {
    expect(streamTestCellColor(-10, -10, 10)).toContain("hsl(240");
    expect(streamTestCellColor(10, -10, 10)).toContain("hsl(0");
  });
});

describe("bleRetryDelayMs", () => {
  it("doubles each attempt and caps at a minute", () => {
    const mid = () => 0.5;
    expect(bleRetryDelayMs(0, mid)).toBe(1_000);
    expect(bleRetryDelayMs(1, mid)).toBe(2_000);
    expect(bleRetryDelayMs(3, mid)).toBe(8_000);
    expect(bleRetryDelayMs(20, mid)).toBe(BLE_RETRY_MAX_MS);
  });

  it("keeps jitter within ±20%", () => {
    for (const r of [0, 0.99]) {
      const d = bleRetryDelayMs(2, () => r);
      expect(d).toBeGreaterThanOrEqual(4_000 * 0.8);
      expect(d).toBeLessThanOrEqual(4_000 * 1.2);
    }
  });
});
