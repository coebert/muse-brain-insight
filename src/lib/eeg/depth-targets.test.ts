import { describe, expect, it } from "vitest";

import { recommendDepthWindow } from "./depth-targets";
import { explainCoebis } from "./coebis-explain";

describe("recommendDepthWindow", () => {
  it("defaults to 40-60 for a GA case with nothing recorded", () => {
    const r = recommendDepthWindow({ context: "general_anaesthesia" });
    expect([r.low, r.high]).toEqual([40, 60]);
    expect(r.isDefault).toBe(true);
  });

  it("lifts the floor for the very old", () => {
    const r = recommendDepthWindow({ context: "general_anaesthesia", ageYears: 84 });
    expect(r.low).toBeGreaterThan(40);
    expect(r.isDefault).toBe(false);
  });

  it("adds a further lift for severe frailty", () => {
    const old = recommendDepthWindow({ context: "general_anaesthesia", ageYears: 84 });
    const frail = recommendDepthWindow({
      context: "general_anaesthesia",
      ageYears: 84,
      frailty: "severe",
    });
    expect(frail.low).toBeGreaterThan(old.low);
  });

  it("uses a lighter window for ICU sedation", () => {
    const r = recommendDepthWindow({ context: "icu_sedation" });
    expect(r.low).toBeGreaterThanOrEqual(60);
  });

  it("widens the ceiling and warns with ketamine", () => {
    const r = recommendDepthWindow({
      context: "general_anaesthesia",
      regimen: "propofol_ketamine",
    });
    expect(r.high).toBeGreaterThan(60);
    expect(r.caveats.join(" ")).toMatch(/ketamine/i);
  });

  it("keeps bounds sane", () => {
    const r = recommendDepthWindow({ context: "icu_sedation", ageYears: 95, frailty: "severe" });
    expect(r.low).toBeLessThan(r.high);
    expect(r.high).toBeLessThanOrEqual(95);
  });
});

describe("explainCoebis", () => {
  const alignment = {
    gain: 0.9,
    offset: -2,
    n: 40,
    fittedAt: new Date().toISOString(),
    version: 3,
    terms: [{ group: "age", level: "75-89", dy: 2, n: 12 }],
  };

  it("reports unavailability without a model", () => {
    const e = explainCoebis(55, null, null);
    expect(e.available).toBe(false);
    expect(e.final).toBeNull();
  });

  it("decomposes affine and covariate steps", () => {
    const e = explainCoebis(60, alignment, { ageBand: "75-89" });
    expect(e.available).toBe(true);
    expect(e.final).toBe(54); // 0.9*60 - 2 + 2
    expect(e.steps.some((s) => s.label.includes("Pooled alignment"))).toBe(true);
    expect(e.steps.some((s) => s.label.includes("age 75-89"))).toBe(true);
    expect(e.netShift).toBeCloseTo(-6, 1);
  });

  it("notes when no patient adjustment applies", () => {
    const e = explainCoebis(60, alignment, null);
    expect(e.caveats.join(" ")).toMatch(/No patient-specific adjustment/i);
  });
});
