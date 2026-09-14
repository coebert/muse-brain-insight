import { describe, expect, it } from "vitest";

import {
  applyTune,
  bandOfLabel,
  fitSedationTune,
  gradeBands,
  IDENTITY_TUNE,
  KNOTS,
  type BandPoint,
} from "./coebis-sedation-bands";

describe("sedation band tuning", () => {
  it("leaves a reading untouched under the identity curve", () => {
    for (const x of [0, 17, 50, 83, 100]) {
      expect(applyTune(IDENTITY_TUNE, x)).toBeCloseTo(x, 6);
    }
  });

  it("maps only the labels that describe a state, not a transition", () => {
    expect(bandOfLabel("awake")).toBe("awake");
    expect(bandOfLabel("sedated_responsive")).toBe("light");
    expect(bandOfLabel("anaesthetised")).toBe("unconscious");
    expect(bandOfLabel("emergence")).toBeNull();
    expect(bandOfLabel("induction")).toBeNull();
  });

  it("pulls compressed readings out to the clinical bands", () => {
    // A model reading everything in the sixties: ordered correctly, but flat.
    const points: BandPoint[] = [];
    for (let i = 0; i < 200; i++) {
      points.push({ index: 68, band: "awake", caseRef: `a${i % 8}` });
      points.push({ index: 64, band: "light", caseRef: `b${i % 8}` });
      points.push({ index: 60, band: "unconscious", caseRef: `c${i % 8}` });
    }
    const tune = fitSedationTune(points, 0)!;
    expect(tune).toBeTruthy();
    const grade = gradeBands(points, tune);
    const awake = grade.find((g) => g.band === "awake")!;
    const deep = grade.find((g) => g.band === "unconscious")!;
    expect(awake.meanAfter).toBeGreaterThan(awake.meanBefore);
    expect(deep.meanAfter).toBeLessThan(deep.meanBefore);
  });

  it("never inverts the order of two readings", () => {
    const points: BandPoint[] = [];
    for (let i = 0; i < 300; i++) {
      points.push({ index: 30 + (i % 5), band: "awake", caseRef: `a${i % 6}` });
      points.push({ index: 90 - (i % 5), band: "unconscious", caseRef: `c${i % 6}` });
    }
    // Deliberately contradictory labels; the curve must still be monotone.
    const tune = fitSedationTune(points, 0)!;
    for (let i = 1; i < KNOTS.length; i++) {
      expect(tune.outputs[i]!).toBeGreaterThanOrEqual(tune.outputs[i - 1]! - 1e-9);
    }
    expect(applyTune(tune, 80)).toBeGreaterThanOrEqual(applyTune(tune, 40));
  });

  it("declines to fit on too little data", () => {
    expect(fitSedationTune([{ index: 50, band: "awake", caseRef: "a" }])).toBeNull();
  });
});
