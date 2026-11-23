import { describe, expect, it } from "vitest";

import { researchWindowFeatures, scoreResearchWindow } from "./research-eeg-baseline";
import models from "./research-eeg-baseline-weights.json";

const sine = (hz: number, seconds: number) =>
  Array.from({ length: seconds * hz }, (_, i) => 20 * Math.sin(2 * Math.PI * 10 * i / hz));

describe("offline EEG baseline", () => {
  for (const hz of [125, 256, 512]) {
    it("extracts an alpha-dominant band with stable RMS at " + hz + " Hz", () => {
      const x = researchWindowFeatures(sine(hz, 4), hz)!;
      expect(x[4]).toBeGreaterThan(0.999);
      expect(x[0]).toBeCloseTo(Math.log1p(20 / Math.sqrt(2)), 9);
      expect(x[7]).toBeGreaterThanOrEqual(10);
      expect(x[7]).toBeLessThanOrEqual(11);
    });
  }

  it("uses the fitted weights and rejects different montages and missing signal", () => {
    const wave = sine(256, 4);
    const input = {
      hz: 256,
      channels: ["FP1-F7", "FP2-F8"],
      samples: [wave, wave],
      units: "uV" as const,
      timedAndGapFree: true as const,
    };
    const score = scoreResearchWindow("seizure_window", models.seizure.weights, input);
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
    expect(scoreResearchWindow("seizure_window", models.seizure.weights, {
      ...input,
      channels: ["AF7", "AF8"],
    })).toBeNull();
    expect(scoreResearchWindow("seizure_window", models.seizure.weights, {
      ...input,
      samples: [wave, [NaN, ...wave.slice(1)]],
    })).toBeNull();
  });

  it("compares a matching retrospective BIS window", () => {
    const score = scoreResearchWindow("bis_agreement_only", models.bis.weights, {
      hz: 125,
      channels: ["Figshare BIS frontal"],
      samples: [sine(125, 5)],
      units: "source-amplitude",
      timedAndGapFree: true,
    });
    expect(score).not.toBeNull();
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
