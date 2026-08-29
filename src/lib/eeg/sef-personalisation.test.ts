import { describe, expect, it } from "vitest";

import {
  applySefPersonalModel,
  fitSefPersonalModel,
  sefCovariateAdjustment,
  sefPersonalModelIsSafe,
  setActiveSefPersonalModel,
  type SefPersonalPoint,
} from "./sef-personalisation";

const AGE_BANDS = ["18-39", "40-59", "60-74", "75-89"];

/**
 * Synthetic paired readings where the monitor offset genuinely depends on age
 * band, plus a per-patient quirk that must not leak between patients.
 */
function makePoints(opts: { patients: number; perPatient: number; ageEffect: number }) {
  const points: SefPersonalPoint[] = [];
  for (let p = 0; p < opts.patients; p++) {
    const band = AGE_BANDS[p % AGE_BANDS.length]!;
    const bandDy = (AGE_BANDS.indexOf(band) - 1.5) * opts.ageEffect;
    const patientDy = ((p % 3) - 1) * 0.3;
    for (let i = 0; i < opts.perPatient; i++) {
      const raw = 8 + ((p * 7 + i * 3) % 11) * 0.6;
      const noise = (((p * 13 + i * 5) % 7) - 3) * 0.05;
      points.push({
        appSef: raw,
        monitorSef: raw + 1.2 + bandDy + patientDy + noise,
        patientKey: `patient-${p}`,
        sessionId: `session-${p}-${i % 2}`,
        reliable: true,
        recordedAt: new Date(Date.UTC(2026, 0, 1 + p, i)).toISOString(),
        covariates: { ageBand: band, sex: p % 2 ? "M" : "F" },
      });
    }
  }
  return points;
}

describe("SEF personalisation", () => {
  it("does not fit without enough separate patients", () => {
    const points = makePoints({ patients: 2, perPatient: 20, ageEffect: 1 });
    expect(fitSefPersonalModel(points)).toBeNull();
  });

  it("learns covariate terms and validates them on held-out patients", () => {
    const model = fitSefPersonalModel(makePoints({ patients: 8, perPatient: 8, ageEffect: 1.2 }));
    expect(model).not.toBeNull();
    expect(model!.patients).toBe(8);
    expect(model!.terms.length).toBeGreaterThan(0);
    expect(model!.cv.folds).toBeGreaterThanOrEqual(2);
    // Cross-validation is grouped by patient, so every patient is scored by a
    // model that never saw any of their own readings.
    expect(model!.cv.maePersonal).toBeLessThan(model!.cv.maeRaw);
    expect(sefPersonalModelIsSafe(model)).toBe(true);
  });

  it("refuses to activate when personalisation does not beat the pooled line", () => {
    const model = fitSefPersonalModel(makePoints({ patients: 8, perPatient: 8, ageEffect: 0 }));
    // Either no term survives the evidence bar, or the gate rejects it.
    expect(sefPersonalModelIsSafe(model)).toBe(false);
  });

  it("caps every learned term so personalisation can only nudge the number", () => {
    const model = fitSefPersonalModel(makePoints({ patients: 8, perPatient: 8, ageEffect: 12 }));
    expect(model).not.toBeNull();
    for (const term of model!.terms) expect(Math.abs(term.dy)).toBeLessThanOrEqual(2);
    for (const dy of Object.values(model!.patientOffsets))
      expect(Math.abs(dy)).toBeLessThanOrEqual(1.5);
  });

  it("applies a patient's longitudinal offset only to that patient", () => {
    const model = fitSefPersonalModel(makePoints({ patients: 8, perPatient: 8, ageEffect: 1.2 }))!;
    const [key, dy] = Object.entries(model.patientOffsets)[0] ?? [];
    if (key == null || dy == null) return; // no offset survived shrinkage
    const cov = { ageBand: "60-74" };
    const own = applySefPersonalModel(12, cov, key, model)!;
    const other = applySefPersonalModel(12, cov, "patient-does-not-exist", model)!;
    const unlinked = applySefPersonalModel(12, cov, null, model)!;
    expect(own - other).toBeCloseTo(dy, 6);
    expect(other).toBeCloseTo(unlinked, 6);
  });

  it("returns null when personalisation is switched off", () => {
    setActiveSefPersonalModel(null);
    expect(applySefPersonalModel(11, { ageBand: "40-59" })).toBeNull();
  });

  it("ignores covariate levels it has not learned", () => {
    const terms = [{ group: "age", level: "75-89", dy: 0.8, n: 10, patients: 3 }];
    expect(sefCovariateAdjustment(terms, { ageBand: "18-39" })).toBe(0);
    expect(sefCovariateAdjustment(terms, { ageBand: "75-89" })).toBeCloseTo(0.8, 6);
  });
});
