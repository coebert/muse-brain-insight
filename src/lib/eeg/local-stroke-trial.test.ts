import { describe, expect, it } from "vitest";
import {
  makeStrokeFixture,
  parseStrokeCheckpoint,
  runStrokeTrial,
  STROKE_FEATURES,
  strokeSampleFeatures,
} from "./local-stroke-trial";

// Independent SciPy reference, computed with the original feature pipeline on these same
// deterministic synthetic samples. Contains no participant data or fitted coefficients.
const expected = {
  symmetric: [
    -2.0199524712, -1.685648755, 0.0481024053, 0.3892127083, 10.5, 0.0016780697, 0.3682504798,
    0.0016780697,
  ],
  slowing: [
    0.09789483, 0.1237108375, 0.0364473564, 0.2368376624, 10.5, 0.8499034389, 0.3918048851,
    0.8499034389,
  ],
};
const testCheckpoint = {
  montage: "frontal",
  target: "Documented prior stroke versus healthy control in resting research EEG",
  threshold: 0.5,
  development: "China only",
  features: STROKE_FEATURES,
  pairs: [
    ["FP1", "F7"],
    ["FP2", "F8"],
    ["F3", "C3"],
    ["F4", "C4"],
    ["C3", "P3"],
    ["C4", "P4"],
    ["P3", "O1"],
    ["P4", "O2"],
  ],
  scale: Array(8).fill(1),
  mean: Array(8).fill(0),
  coef: [1, 0, 0, 0, 0, 0, 0, 0],
  intercept: 0,
};

describe("local prior-stroke research replay", () => {
  for (const id of ["symmetric", "slowing"] as const) {
    it(`reproduces the SciPy features for the ${id} recording`, () => {
      const { features, good } = strokeSampleFeatures(makeStrokeFixture(id));
      expect(good).toBe(15);
      expected[id].forEach((v, i) => expect(features?.[i]).toBeCloseTo(v, 7));
    });
  }
  it("rejects incompatible weights and returns no score after loss of a frontal lead", () => {
    expect(() =>
      parseStrokeCheckpoint(JSON.stringify({ ...testCheckpoint, montage: "broad" })),
    ).toThrow();
    expect(() =>
      parseStrokeCheckpoint(JSON.stringify({ ...testCheckpoint, scale: Array(8).fill(0) })),
    ).toThrow();
    expect(() =>
      parseStrokeCheckpoint(
        JSON.stringify({ ...testCheckpoint, features: [...STROKE_FEATURES].reverse() }),
      ),
    ).toThrow();
    const model = parseStrokeCheckpoint(JSON.stringify(testCheckpoint));
    expect(runStrokeTrial(model, "flat")).toEqual({ score: null, good: 0 });
    expect(runStrokeTrial(model, "symmetric").score).toBeCloseTo(
      1 / (1 + Math.exp(-expected.symmetric[0]!)),
      7,
    );
  });
  it("withholds the score for fewer than eight usable windows", () => {
    const patient = makeStrokeFixture("symmetric");
    patient[0].fill(NaN, 7 * 8 * 500);
    expect(strokeSampleFeatures(patient)).toEqual({ good: 7, features: null });
  });
});
