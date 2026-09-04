import { describe, expect, it } from "vitest";

import {
  declaredDrugs,
  drugStage,
  drugStageHint,
  MAX_DRUG_TOTAL,
  sedativeSpindleScore,
} from "../drug-signatures";
import type { KetamineFeatures } from "../ketamine";

/** Activated frontal spectrum: lots of fast power, slow activity preserved. */
const fast: KetamineFeatures = {
  betaFraction: 0.3,
  gammaFraction: 0.14,
  alphaFraction: 0.08,
  slowFraction: 0.35,
};

/** Spindle-rich NREM-like spectrum: alpha spindle, slow-dominant, quiet fast. */
const spindly: KetamineFeatures = {
  betaFraction: 0.05,
  gammaFraction: 0.02,
  alphaFraction: 0.26,
  slowFraction: 0.5,
};

const base = { bsr: 0, quality: 1 } as const;

describe("declaredDrugs", () => {
  it("reads agents out of the regimen, notes and pump concentrations", () => {
    expect(
      declaredDrugs({
        regimen: "Sevoflurane + nitrous oxide",
        notes: ["midazolam 2 mg at induction"],
        ce: { remifentanil: 3.2 },
      }),
    ).toEqual(["nitrous_oxide", "benzodiazepine", "volatile", "opioid"]);
  });

  it("ignores a drug recorded at zero concentration", () => {
    expect(declaredDrugs({ ce: { ketamine: 0 } })).toEqual([]);
  });
});

describe("drugStage", () => {
  it("pulls the index down for declared nitrous oxide showing the fast pattern", () => {
    const stage = drugStage({ ...base, aligned: 68, features: fast, declared: ["nitrous_oxide"] });
    expect(stage.delta).toBeLessThan(0);
    expect(stage.delta).toBeGreaterThanOrEqual(-8);
    expect(stage.entries[0]?.key).toBe("nitrous_oxide");
  });

  it("pushes the index up for dexmedetomidine reading spuriously deep", () => {
    const stage = drugStage({ ...base, aligned: 42, features: spindly, declared: ["dexmedetomidine"] });
    expect(stage.delta).toBeGreaterThan(0);
    expect(42 + stage.delta).toBeLessThanOrEqual(75);
  });

  it("never pushes an already-light index above the dexmedetomidine ceiling", () => {
    const stage = drugStage({ ...base, aligned: 74, features: spindly, declared: ["dexmedetomidine"] });
    expect(74 + stage.delta).toBeLessThanOrEqual(75);
  });

  it("subtracts nothing for propofol or volatile — they are the reference drugs", () => {
    const stage = drugStage({ ...base, aligned: 45, features: fast, declared: ["propofol", "volatile"] });
    expect(stage.delta).toBe(0);
    expect(stage.reference).toEqual(["propofol", "volatile"]);
    expect(stage.reasons.length).toBe(2);
  });

  it("subtracts nothing for opioids", () => {
    const stage = drugStage({ ...base, aligned: 45, features: fast, declared: ["opioid"] });
    expect(stage.delta).toBe(0);
  });

  it("does not correct an undeclared agent, only advises", () => {
    const stage = drugStage({ ...base, aligned: 68, features: fast, declared: [] });
    expect(stage.delta).toBe(0);
    expect(stage.advisories.length).toBeGreaterThan(0);
  });

  it("skips agents handled by an earlier stage so nothing is subtracted twice", () => {
    const stage = drugStage({
      ...base,
      aligned: 60,
      features: fast,
      declared: ["ketamine"],
      handledElsewhere: ["ketamine"],
    });
    expect(stage.delta).toBe(0);
    expect(stage.entries).toHaveLength(0);
  });

  it("keeps the combined movement inside the total cap", () => {
    const stage = drugStage({
      ...base,
      aligned: 95,
      features: fast,
      declared: ["nitrous_oxide", "xenon", "benzodiazepine"],
      alreadyApplied: -12,
    });
    expect(Math.abs(stage.delta) + 12).toBeLessThanOrEqual(MAX_DRUG_TOTAL);
  });

  it("stands down inside suppression, where the index is governed by the burst pattern", () => {
    const stage = drugStage({ ...base, bsr: 40, aligned: 30, features: fast, declared: ["nitrous_oxide"] });
    expect(stage.delta).toBe(0);
  });

  it("shrinks the correction when the signal is poor", () => {
    const clean = drugStage({ ...base, aligned: 68, features: fast, declared: ["nitrous_oxide"] });
    const noisy = drugStage({ ...base, quality: 0.4, aligned: 68, features: fast, declared: ["nitrous_oxide"] });
    expect(Math.abs(noisy.delta)).toBeLessThan(Math.abs(clean.delta));
  });

  it("does nothing without an index", () => {
    expect(drugStage({ ...base, aligned: null, features: fast, declared: ["nitrous_oxide"] }).delta).toBe(0);
  });
});

describe("sedativeSpindleScore", () => {
  it("is zero for an activated spectrum", () => {
    expect(sedativeSpindleScore(fast)).toBe(0);
  });

  it("is zero when the bands are missing", () => {
    expect(
      sedativeSpindleScore({ alphaFraction: null, slowFraction: null, betaFraction: null, gammaFraction: null }),
    ).toBe(0);
  });
});

describe("drugStageHint", () => {
  it("names the agents that moved the number", () => {
    const stage = drugStage({ ...base, aligned: 68, features: fast, declared: ["nitrous_oxide"] });
    expect(drugStageHint(stage)).toMatch(/nitrous oxide/);
  });

  it("says nothing when there is nothing to say", () => {
    expect(drugStageHint(drugStage({
        ...base,
        aligned: 50,
        features: { betaFraction: 0.1, gammaFraction: 0.04, alphaFraction: 0.1, slowFraction: 0.4 },
        declared: [],
      }))).toBeNull();
  });
});
