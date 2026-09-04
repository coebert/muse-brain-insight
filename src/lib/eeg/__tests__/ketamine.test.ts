import { describe, expect, it } from "vitest";

import {
  KETAMINE_CAP,
  KETAMINE_FLOOR,
  ketamineCorrection,
  ketamineDeclared,
  ketamineScore,
  type KetamineFeatures,
} from "../ketamine";

/** Activated anaesthetised EEG: strong beta/gamma, no alpha spindle, slow waves kept. */
const KETAMINE_LIKE: KetamineFeatures = {
  betaFraction: 0.2,
  gammaFraction: 0.14,
  alphaFraction: 0.05,
  slowFraction: 0.45,
};

/** Classic propofol pattern. */
const PROPOFOL_LIKE: KetamineFeatures = {
  betaFraction: 0.06,
  gammaFraction: 0.03,
  alphaFraction: 0.22,
  slowFraction: 0.55,
};

/** Awake: fast activity but no slow-wave evidence. */
const AWAKE_LIKE: KetamineFeatures = {
  betaFraction: 0.24,
  gammaFraction: 0.14,
  alphaFraction: 0.1,
  slowFraction: 0.12,
};

describe("ketamine detector", () => {
  it("scores the ketamine pattern high and the propofol pattern at zero", () => {
    expect(ketamineScore(KETAMINE_LIKE).score).toBeGreaterThan(0.7);
    expect(ketamineScore(PROPOFOL_LIKE).score).toBe(0);
  });

  it("does not score fast activity without slow-wave evidence", () => {
    expect(ketamineScore(AWAKE_LIKE).score).toBe(0);
  });

  it("recognises declared exposure from the regimen, a Ce or a marker", () => {
    expect(ketamineDeclared({ regimen: "propofol_ketamine" })).toBe(true);
    expect(ketamineDeclared({ ketamineCe: 0.4 })).toBe(true);
    expect(ketamineDeclared({ markers: ["ketamine 30 mg"] })).toBe(true);
    expect(ketamineDeclared({ regimen: "propofol_tiva", markers: ["incision"] })).toBe(false);
  });
});

describe("ketamine correction", () => {
  it("lowers COEBIS when ketamine is declared and the pattern is present", () => {
    const k = ketamineCorrection({
      aligned: 72,
      features: KETAMINE_LIKE,
      exposure: "declared",
      bsr: 0,
    });
    expect(k.corrected).toBe(true);
    expect(k.delta).toBeLessThan(0);
    expect(Math.abs(k.delta)).toBeLessThanOrEqual(KETAMINE_CAP);
    expect(72 + k.delta).toBeGreaterThanOrEqual(KETAMINE_FLOOR);
  });

  it("never moves the number on the EEG pattern alone", () => {
    const k = ketamineCorrection({
      aligned: 72,
      features: KETAMINE_LIKE,
      exposure: "none",
      bsr: 0,
    });
    expect(k.delta).toBe(0);
    expect(k.corrected).toBe(false);
    expect(k.advisory).toBe(true);
  });

  it("cannot pull the index below the floor", () => {
    const k = ketamineCorrection({
      aligned: 45,
      features: KETAMINE_LIKE,
      exposure: "declared",
      bsr: 0,
    });
    expect(45 + k.delta).toBeGreaterThanOrEqual(KETAMINE_FLOOR);
  });

  it("stands aside in suppression and when the index already reads deep", () => {
    expect(
      ketamineCorrection({ aligned: 70, features: KETAMINE_LIKE, exposure: "declared", bsr: 35 })
        .delta,
    ).toBe(0);
    expect(
      ketamineCorrection({ aligned: 32, features: KETAMINE_LIKE, exposure: "declared", bsr: 0 })
        .delta,
    ).toBe(0);
  });

  it("applies nothing when ketamine is declared but the pattern is absent", () => {
    const k = ketamineCorrection({
      aligned: 70,
      features: PROPOFOL_LIKE,
      exposure: "declared",
      bsr: 0,
    });
    expect(k.delta).toBe(0);
    expect(k.reasons.join(" ")).toContain("does not currently show");
  });

  it("shrinks with a poor signal", () => {
    const good = ketamineCorrection({
      aligned: 80,
      features: KETAMINE_LIKE,
      exposure: "declared",
      bsr: 0,
      quality: 1,
    });
    const poor = ketamineCorrection({
      aligned: 80,
      features: KETAMINE_LIKE,
      exposure: "declared",
      bsr: 0,
      quality: 0.4,
    });
    expect(Math.abs(poor.delta)).toBeLessThan(Math.abs(good.delta));
  });
});

describe("filed ketamine flag", () => {
  it("declares exposure from the filed flag alone", () => {
    expect(ketamineDeclared({ flag: true })).toBe(true);
    expect(ketamineEvidence({ flag: true })).toBe("filed");
  });

  it("rules exposure out even when free text mentions the drug", () => {
    expect(ketamineDeclared({ regimen: "propofol, ketamine considered", flag: false })).toBe(false);
    expect(ketamineEvidence({ regimen: "ketamine considered", flag: false })).toBe("filed");
  });

  it("falls back to the record when nothing is filed", () => {
    expect(ketamineDeclared({ regimen: "propofol / ketamine" })).toBe(true);
    expect(ketamineEvidence({ regimen: "propofol / ketamine" })).toBe("inferred");
    expect(ketamineEvidence({ regimen: "propofol" })).toBe("none");
  });
});
