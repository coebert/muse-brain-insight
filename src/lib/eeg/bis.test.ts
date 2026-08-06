import { describe, expect, it } from "vitest";

import { buildBisComparison, clampBis, bisBandLabel, type BisReading } from "@/lib/eeg/bis";
import type { Epoch } from "@/lib/eeg/analysis";

function epoch(t: number, depth: number, sr = 0): Epoch {
  return {
    t,
    spectrum: [],
    bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    ratios: { deltaAlpha: 0, betaAlpha: 0, thetaAlpha: 0 },
    entropy: { shannon: 0, sef: 0, state: 0, response: 0 },
    totalPower: 0,
    sef95: 12,
    epochSuppression: 0,
    isSuppressed: false,
    suppressionRatio: sr,
    seizureScore: 0,
    seizureAlert: false,
    artifact: false,
    amplitudeUv: 20,
    quality: {
      score: 0.9,
      grade: "good",
      clipFraction: 0,
      emgIndex: 0,
      jumpRate: 0,
      amplitudeUv: 20,
      flat: false,
      reasons: [],
    },
    confidence: {} as Epoch["confidence"],
    depthReliability: { level: "high", reliable: true, reasons: [] },
    depth: {
      index: depth,
      raw: depth,
      state: "general_anaesthesia",
      components: {} as Epoch["depth"]["components"],
      held: false,
      heldSeconds: 0,
      gatedFraction: 0,
    } as Epoch["depth"],
    depthArtifact: {} as Epoch["depthArtifact"],
    composite: { cIndex: null, nIndex: null } as Epoch["composite"],
  } as Epoch;
}

const readings = (values: [number, number][]): BisReading[] =>
  values.map(([at, bis], i) => ({ id: `r${i}`, at, bis }));

describe("BIS reference comparison", () => {
  it("clamps and bands transcribed values", () => {
    expect(clampBis(140)).toBe(100);
    expect(clampBis(-3)).toBe(0);
    expect(bisBandLabel(45)).toContain("Surgical");
  });

  it("pairs readings with the nearest epoch and reports bias", () => {
    const epochs = [epoch(0, 55), epoch(60, 50), epoch(120, 45), epoch(180, 40), epoch(240, 35)];
    const digest = buildBisComparison(
      epochs,
      readings([
        [0, 50],
        [60, 45],
        [120, 40],
        [180, 35],
        [240, 30],
      ]),
      240,
    );
    expect(digest.paired).toBe(5);
    expect(digest.metrics?.bias).toBeCloseTo(5, 5);
    expect(digest.metrics?.r).toBeCloseTo(1, 5);
    expect(digest.calibration?.maeAfter).toBeLessThanOrEqual(digest.calibration!.maeBefore);
  });

  it("leaves readings unpaired when no EEG is near", () => {
    const digest = buildBisComparison([epoch(0, 50)], readings([[600, 45]]), 700);
    expect(digest.paired).toBe(0);
    expect(digest.unpaired).toBe(1);
    expect(digest.sparse).toBe(true);
  });

  it("flags large divergences", () => {
    const epochs = [epoch(0, 80), epoch(60, 50)];
    const digest = buildBisComparison(
      epochs,
      readings([
        [0, 45],
        [60, 48],
      ]),
      60,
    );
    expect(digest.divergences).toHaveLength(1);
    expect(digest.divergences[0]!.difference).toBe(35);
  });
});
