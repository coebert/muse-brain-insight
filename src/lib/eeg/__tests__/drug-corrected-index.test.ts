import { describe, expect, it } from "vitest";

import { drugCorrectedIndex } from "../drug-corrected-index";
import { recordedDrugs } from "../pathology-labels.server";

/** Band powers with a ketamine-like fast-activity share. */
const fastBands = { delta: 30, theta: 10, alpha: 4, beta: 22, gamma: 12 };
/** Ordinary GABAergic shape: alpha spindle over slow activity, little fast. */
const spindleBands = { delta: 45, theta: 12, alpha: 22, beta: 4, gamma: 1 };

describe("drugCorrectedIndex", () => {
  it("leaves the index alone when no agent is recorded", () => {
    const out = drugCorrectedIndex({
      coebis: 62,
      bands: fastBands,
      declared: [],
      suppressionPct: 0,
    });
    expect(out).toEqual({ index: 62, delta: 0, applied: [] });
  });

  it("returns nothing when there is no index to correct", () => {
    expect(
      drugCorrectedIndex({ coebis: null, bands: fastBands, declared: ["ketamine"], suppressionPct: 0 }),
    ).toEqual({ index: null, delta: 0, applied: [] });
  });

  it("pulls the index down for a recorded fast-activity agent", () => {
    const out = drugCorrectedIndex({
      coebis: 62,
      bands: fastBands,
      declared: ["ketamine"],
      suppressionPct: 0,
    });
    expect(out.delta).toBeLessThan(0);
    expect(out.index!).toBeLessThan(62);
    expect(out.applied).toContain("ketamine");
  });

  it("lifts the index for a recorded alpha-2 agonist on a spindle-rich epoch", () => {
    const out = drugCorrectedIndex({
      coebis: 40,
      bands: spindleBands,
      declared: ["dexmedetomidine"],
      suppressionPct: 0,
    });
    expect(out.delta).toBeGreaterThan(0);
    expect(out.applied).toContain("dexmedetomidine");
  });

  it("does not move a reference agent such as propofol", () => {
    const out = drugCorrectedIndex({
      coebis: 40,
      bands: spindleBands,
      declared: ["propofol"],
      suppressionPct: 0,
    });
    expect(out.delta).toBe(0);
    expect(out.applied).toEqual([]);
  });

  it("stands down inside heavy suppression, where suppression governs the number", () => {
    const out = drugCorrectedIndex({
      coebis: 25,
      bands: fastBands,
      declared: ["ketamine"],
      suppressionPct: 40,
    });
    expect(out.delta).toBe(0);
  });

  it("keeps the corrected index inside 0-100", () => {
    const out = drugCorrectedIndex({
      coebis: 3,
      bands: fastBands,
      declared: ["ketamine"],
      suppressionPct: 0,
    });
    expect(out.index!).toBeGreaterThanOrEqual(0);
    expect(out.index!).toBeLessThanOrEqual(100);
  });

  it("returns the raw index when the epoch kept no band powers", () => {
    const out = drugCorrectedIndex({
      coebis: 55,
      bands: null,
      declared: ["ketamine"],
      suppressionPct: 0,
    });
    expect(out.index).toBe(55);
    expect(out.delta).toBe(0);
  });
});

describe("recordedDrugs", () => {
  it("reads agents from the regimen, notes and effect-site entries", () => {
    expect(recordedDrugs({ regimen: "TIVA propofol + ketamine" })).toContain("ketamine");
    expect(recordedDrugs({ drugs: "sevoflurane, remifentanil" })).toContain("volatile");
    expect(recordedDrugs({ ce: { dexmedetomidine: 0.6 } })).toContain("dexmedetomidine");
  });

  it("ignores an effect-site entry that is zero, and an empty record", () => {
    expect(recordedDrugs({ ce: { ketamine: 0 } })).toEqual([]);
    expect(recordedDrugs(null)).toEqual([]);
  });
});
