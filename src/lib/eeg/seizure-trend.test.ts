import { describe, expect, it } from "vitest";

import { computeSeizureTrend, DEFAULT_SEIZURE_TREND } from "@/lib/eeg/seizure-trend";
import type { Epoch } from "@/lib/eeg/analysis";

function epoch(t: number, score: number, quality = 0.9): Epoch {
  return {
    t,
    seizureScore: score,
    quality: { score: quality, emgIndex: 0.1 },
    confidence: { seizure: 0.8 },
  } as unknown as Epoch;
}

describe("computeSeizureTrend", () => {
  it("returns an empty trend without enough usable epochs", () => {
    expect(computeSeizureTrend([], DEFAULT_SEIZURE_TREND).status).toBe("unknown");
    expect(computeSeizureTrend([epoch(0, 0.9)], DEFAULT_SEIZURE_TREND).samples).toBe(0);
  });

  it("flags sustained elevation above the risk threshold", () => {
    const epochs = Array.from({ length: 40 }, (_, i) => epoch(i * 2, 0.8));
    const trend = computeSeizureTrend(epochs, DEFAULT_SEIZURE_TREND);
    expect(trend.status).toBe("elevated");
    expect(trend.risk).toBeGreaterThan(DEFAULT_SEIZURE_TREND.riskThreshold);
    expect(trend.aboveSeconds).toBeGreaterThan(DEFAULT_SEIZURE_TREND.dwellSeconds);
  });

  it("measures rate of rise per minute", () => {
    const epochs = Array.from({ length: 30 }, (_, i) => epoch(i * 2, i / 40));
    const trend = computeSeizureTrend(epochs, DEFAULT_SEIZURE_TREND);
    expect(trend.risePerMinute).toBeGreaterThan(0.1);
  });

  it("ignores epochs below the quality floor", () => {
    const epochs = [
      ...Array.from({ length: 20 }, (_, i) => epoch(i * 2, 0.1)),
      ...Array.from({ length: 20 }, (_, i) => epoch(40 + i * 2, 0.95, 0.1)),
    ];
    const trend = computeSeizureTrend(epochs, DEFAULT_SEIZURE_TREND);
    expect(trend.samples).toBe(20);
    expect(trend.risk).toBeLessThan(DEFAULT_SEIZURE_TREND.riskThreshold);
  });
});
