import { describe, expect, it } from "vitest";

import {
  CAP_FLOOR_INDEX,
  CAP_ONSET_PCT,
  MAX_INDEX_CAP_SHIFT,
  MONITOR_SUPPRESSED_PCT,
  caseDisagreements,
  crossValidate,
  emptyReport,
  fitSuppressionModel,
  gradeEstimates,
  gradePairing,
  pairWithCoebis,
  predictSr,
  type SuppressionPoint,
} from "../suppression-model";

/**
 * A synthetic pool where the app's detector reads systematically low: the
 * monitor's SR runs at roughly 1.6x the app's, which is exactly the kind of
 * fixed scaling a calibration should absorb.
 */
function pool(cases = 8, perCase = 60): SuppressionPoint[] {
  const out: SuppressionPoint[] = [];
  for (let c = 0; c < cases; c++) {
    for (let i = 0; i < perCase; i++) {
      const appSr = (i / perCase) * 50;
      const bisSr = Math.min(100, appSr * 1.6 + (c % 3) - 1);
      out.push({
        caseRef: `case-${c}`,
        atSeconds: i * 10,
        appSr,
        bisSr: Math.max(0, bisSr),
        appIndex: Math.max(10, 70 - appSr),
        bis: Math.max(10, 66 - appSr),
        sqi: 0.9,
        reliable: true,
      });
    }
  }
  return out;
}

describe("fitSuppressionModel", () => {
  it("refuses to fit on too few readings", () => {
    expect(fitSuppressionModel(pool(1, 5))).toBeNull();
  });

  it("learns the scaling between the app detector and the monitor", () => {
    const model = fitSuppressionModel(pool());
    expect(model).not.toBeNull();
    // At 30% app SR the monitor sits near 48%; the raw detector would say 30.
    const predicted = predictSr(model!, 30, 40);
    expect(predicted).toBeGreaterThan(38);
    expect(predicted).toBeLessThan(58);
  });

  it("keeps predictions inside 0-100 however extreme the input", () => {
    const model = fitSuppressionModel(pool())!;
    expect(predictSr(model, -50, 0)).toBeGreaterThanOrEqual(0);
    expect(predictSr(model, 999, 0)).toBeLessThanOrEqual(100);
  });

  it("is monotone: more flat time never predicts less suppression", () => {
    const model = fitSuppressionModel(pool())!;
    let previous = -1;
    for (let sr = 0; sr <= 100; sr += 5) {
      const p = predictSr(model, sr, null);
      expect(p).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = p;
    }
  });
});

describe("gradeEstimates", () => {
  it("scores the raw detector as biased low against the monitor", () => {
    const grade = gradeEstimates(pool(), (p) => p.appSr);
    expect(grade.agreement.bias).toBeLessThan(0);
    expect(grade.agreement.n).toBe(480);
  });

  it("counts a missed suppression as a miss, not a false alarm", () => {
    const points: SuppressionPoint[] = [
      {
        caseRef: "a",
        atSeconds: 0,
        appSr: 0,
        bisSr: 40,
        appIndex: 50,
        bis: 40,
        sqi: 1,
        reliable: true,
      },
    ];
    const grade = gradeEstimates(points, (p) => p.appSr);
    expect(grade.detection.missed).toBe(1);
    expect(grade.detection.falseAlarms).toBe(0);
    expect(grade.detection.sensitivity).toBe(0);
  });

  it("returns null discrimination when only one class is present", () => {
    const grade = gradeEstimates(
      [
        {
          caseRef: "a",
          atSeconds: 0,
          appSr: 30,
          bisSr: 40,
          appIndex: 30,
          bis: 30,
          sqi: 1,
          reliable: true,
        },
      ],
      (p) => p.appSr,
    );
    expect(grade.detection.auc).toBeNull();
    expect(grade.detection.specificity).toBeNull();
  });
});

describe("crossValidate", () => {
  it("beats the raw detector out of sample on a scaled pool", () => {
    const report = crossValidate("vitaldb", pool());
    expect(report.after.agreement.mae!).toBeLessThan(report.before.agreement.mae!);
    expect(report.maeGain!).toBeGreaterThan(0);
    expect(report.promotable).toBe(true);
    expect(report.blockedBy).toBeNull();
  });

  it("holds the fit back when too few cases carry suppression", () => {
    const thin = pool(2, 30).map((p) => ({ ...p, bisSr: 0 }));
    const report = crossValidate("vitaldb", thin);
    expect(report.promotable).toBe(false);
    expect(report.blockedBy).toBeTruthy();
  });

  it("never trains and tests on the same case", () => {
    const report = crossValidate("vitaldb", pool(6, 80), 3);
    expect(report.folds).toBe(3);
    expect(report.cases).toBe(6);
  });
});

describe("pairWithCoebis", () => {
  it("does nothing below the onset", () => {
    const paired = pairWithCoebis(70, CAP_ONSET_PCT - 1);
    expect(paired.engaged).toBe(false);
    expect(paired.cappedIndex).toBe(70);
  });

  it("only ever lowers the index", () => {
    for (let sr = 0; sr <= 100; sr += 10) {
      expect(pairWithCoebis(45, sr).cappedIndex).toBeLessThanOrEqual(45);
    }
  });

  it("never removes more than the bounded shift", () => {
    const paired = pairWithCoebis(90, 100);
    expect(paired.shift).toBeLessThanOrEqual(MAX_INDEX_CAP_SHIFT + 1e-9);
  });

  it("never pushes the index below the floor", () => {
    expect(pairWithCoebis(25, 100).cappedIndex).toBeGreaterThanOrEqual(CAP_FLOOR_INDEX);
  });
});

describe("gradePairing", () => {
  it("reduces readings that look light inside recorded suppression", () => {
    const points: SuppressionPoint[] = Array.from({ length: 30 }, (_, i) => ({
      caseRef: `case-${i % 5}`,
      atSeconds: i,
      appSr: 45,
      bisSr: 70,
      appIndex: 75,
      bis: 25,
      sqi: 1,
      reliable: true,
    }));
    const model = fitSuppressionModel(pool());
    const grade = gradePairing(points, model);
    expect(grade.falselyLightBefore).toBe(30);
    expect(grade.falselyLightAfter).toBeLessThan(grade.falselyLightBefore);
    expect(grade.gain!).toBeGreaterThan(0);
  });

  it("leaves clear readings untouched", () => {
    const points: SuppressionPoint[] = Array.from({ length: 10 }, (_, i) => ({
      caseRef: "case-0",
      atSeconds: i,
      appSr: 0,
      bisSr: 0,
      appIndex: 55,
      bis: 52,
      sqi: 1,
      reliable: true,
    }));
    const grade = gradePairing(points, fitSuppressionModel(pool()));
    expect(grade.engaged).toBe(0);
    expect(grade.maeAfter).toBe(grade.maeBefore);
  });
});

describe("caseDisagreements", () => {
  it("ranks the worst-disagreeing case first", () => {
    const points = [
      ...pool(2, 30),
      ...Array.from({ length: 30 }, (_, i) => ({
        caseRef: "rogue",
        atSeconds: i,
        appSr: 0,
        bisSr: 80,
        appIndex: 60,
        bis: 20,
        sqi: 1,
        reliable: true,
      })),
    ];
    const ranked = caseDisagreements(points, null);
    expect(ranked[0]!.caseRef).toBe("rogue");
    expect(ranked[0]!.suppressedPoints).toBe(30);
  });
});

describe("emptyReport", () => {
  it("says plainly that nothing has been fitted", () => {
    const report = emptyReport();
    expect(report.fit.promotable).toBe(false);
    expect(report.fit.blockedBy).toContain("no paired suppression readings");
    expect(MONITOR_SUPPRESSED_PCT).toBe(5);
  });
});
