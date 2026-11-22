import { describe, expect, it } from "vitest";
import { runSampleResearch } from "./sample-research";

describe("research lab synthetic EEG samples", () => {
  // Expected ages were independently calculated from the same generated six
  // leads with research/resting-eeg-age's published Python/SciPy scorer.
  it.each([
    ["rest-alpha", 29.783721561003308],
    ["rest-slow", 40.034852671121065],
  ] as const)("matches the reference age estimate for %s at displayed precision", (sample, referenceAge) => {
    const result = runSampleResearch("age", sample);
    expect(result.state).toBe("scored");
    expect(result.value).toBe(referenceAge.toFixed(1));
    expect(result.unit).toBe("years");
    expect(result.waveform).toHaveLength(8 * result.sampleRate);
    expect(result.waveform.every(Number.isFinite)).toBe(true);
  });

  it.each(["age", "stroke"] as const)("withholds the %s result for poor contact", (kind) => {
    const result = runSampleResearch(kind, "poor-signal");
    expect(result.state).toBe("withheld");
    expect(result.value).toBe("Withheld");
    expect(result.unit).toBe("");
  });

  it("reports hemispheric change only in the asymmetric example", () => {
    const symmetric = runSampleResearch("stroke", "symmetric");
    expect(symmetric.state).toBe("scored");
    expect(symmetric.value).toBe("Balanced");
    const left = runSampleResearch("stroke", "left-change");
    expect(left.state).toBe("scored");
    expect(left.value).toBe("Left side");
    expect(left.description).toContain("71%");
  });
});
