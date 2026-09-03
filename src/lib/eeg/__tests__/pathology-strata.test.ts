import { describe, expect, it } from "vitest";

import {
  classifyPattern,
  evaluateByPathology,
  pathologyLabels,
  type PathologyPoint,
} from "../pathology-strata";

function point(
  overrides: Partial<PathologyPoint> & { bis: number; appIndex: number },
): PathologyPoint {
  return {
    at: 0,
    recordedAt: new Date().toISOString(),
    sessionId: "case-1",
    reliable: true,
    sqi: 1,
    context: "anaesthesia",
    ce: null,
    cov: {
      ageBand: "60-74",
      sex: "male",
      regimen: "propofol_opioid",
      frailty: null,
      chronicBurden: null,
      chronicCns: null,
      acuteClass: null,
    },
    ...overrides,
  } as PathologyPoint;
}

describe("classifyPattern", () => {
  it("puts suppression ahead of a raised seizure score", () => {
    expect(
      classifyPattern({ suppressionRatio: 40, isSuppressed: true, seizureScore: 0.9 }),
    ).toBe("burst_suppression");
  });

  it("flags seizure-like patterns on a continuous trace", () => {
    expect(classifyPattern({ suppressionRatio: 0, isSuppressed: false, seizureScore: 0.8 })).toBe(
      "seizure_pattern",
    );
  });

  it("separates discontinuous from continuous", () => {
    expect(classifyPattern({ suppressionRatio: 4, isSuppressed: false, seizureScore: 0.1 })).toBe(
      "discontinuous",
    );
    expect(classifyPattern({ suppressionRatio: 0, isSuppressed: false, seizureScore: 0.1 })).toBe(
      "continuous",
    );
  });

  it("returns unknown without an epoch", () => {
    expect(classifyPattern(null)).toBe("unknown");
  });
});

describe("pathologyLabels", () => {
  it("labels pattern, regimen, pathology and clinical features", () => {
    const p = point({
      bis: 40,
      appIndex: 45,
      epoch: { suppressionRatio: 30, isSuppressed: true, seizureScore: 0 },
      careContext: "icu",
      clinicalFeatures: ["sepsis"],
      cov: {
        ageBand: "60-74",
        sex: "male",
        regimen: "propofol_opioid",
        frailty: null,
        chronicBurden: null,
        chronicCns: "dementia",
        acuteClass: "hypoxic_brain_injury",
      },
    });
    expect(pathologyLabels(p)).toEqual(
      expect.arrayContaining([
        ["pattern", "Burst suppression"],
        ["regimen", "propofol_opioid"],
        ["acute", "hypoxic_brain_injury"],
        ["chronicCns", "dementia"],
        ["care", "icu"],
        ["feature", "sepsis"],
      ]),
    );
  });
});

describe("evaluateByPathology", () => {
  const points: PathologyPoint[] = [];
  // Continuous readings the model tracks well.
  for (let i = 0; i < 20; i++) {
    points.push(
      point({
        sessionId: `case-${i % 5}`,
        at: i,
        bis: 45 + (i % 3),
        appIndex: 46 + (i % 3),
        epoch: { suppressionRatio: 0, isSuppressed: false, seizureScore: 0.05 },
      }),
    );
  }
  // Burst-suppression readings where the model reads badly light.
  for (let i = 0; i < 20; i++) {
    points.push(
      point({
        sessionId: `case-${i % 5}`,
        at: 100 + i,
        bis: 20,
        appIndex: 35,
        epoch: { suppressionRatio: 45, isSuppressed: true, seizureScore: 0.2 },
      }),
    );
  }

  const evaluation = evaluateByPathology(points, (p) => p.appIndex);

  it("reports per-group bias and error", () => {
    const bs = evaluation.strata.find((s) => s.level === "Burst suppression")!;
    const cont = evaluation.strata.find((s) => s.level === "Continuous")!;
    expect(bs.after.bias).toBeCloseTo(15, 5);
    expect(bs.after.mae).toBeCloseTo(15, 5);
    expect(cont.after.mae).toBeLessThan(2);
    expect(bs.cases).toBe(5);
  });

  it("marks the badly-performing group as a weak spot", () => {
    expect(evaluation.weakSpots.map((s) => s.level)).toContain("Burst suppression");
    expect(evaluation.weakSpots[0]!.maeGap).toBeGreaterThan(3);
  });

  it("flags thin strata rather than reporting them as sufficient", () => {
    const thin = evaluateByPathology(
      [point({ bis: 50, appIndex: 52, epoch: { suppressionRatio: 0, isSuppressed: false, seizureScore: 0 } })],
      (p) => p.appIndex,
    );
    expect(thin.strata.every((s) => s.sufficiency !== "sufficient")).toBe(true);
    expect(thin.gaps.length).toBeGreaterThan(0);
  });

  it("skips readings with no held-out prediction", () => {
    const e = evaluateByPathology(points, (_p, i) => (i % 2 === 0 ? null : points[i]!.appIndex));
    expect(e.scored).toBe(points.length / 2);
    expect(e.points).toBe(points.length);
  });
});
