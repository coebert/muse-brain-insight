import { describe, expect, it } from "vitest";

import { VALIDATION_REGISTRY, isHumanEvidence } from "./validation-registry";

describe("validation registry", () => {
  it("claims no prospective validation for any task", () => {
    for (const e of Object.values(VALIDATION_REGISTRY)) expect(e.prospectivelyValidated).toBe(false);
  });

  it("marks the seizure vignettes as synthetic, not human evidence", () => {
    expect(VALIDATION_REGISTRY.seizure.evidence).toBe("synthetic-regression");
    expect(isHumanEvidence(VALIDATION_REGISTRY.seizure.evidence)).toBe(false);
  });

  it("marks the asymmetry watch as having no imaging validation", () => {
    expect(isHumanEvidence(VALIDATION_REGISTRY.asymmetry.evidence)).toBe(false);
    expect(VALIDATION_REGISTRY.asymmetry.notShown).toMatch(/no imaging validation/i);
  });

  it("describes COEBIS-2 as BIS agreement on 28 cases, not an outperformance claim", () => {
    const e = VALIDATION_REGISTRY["bis-agreement"];
    expect(e.evidence).toBe("retrospective-agreement");
    expect(e.basis).toMatch(/28 retrospective/);
    expect(e.notShown).toMatch(/not a claim to outperform BIS/i);
  });

  it("keeps disease patterns unvalidated", () => {
    expect(VALIDATION_REGISTRY["disease-pattern"].evidence).toBe("none");
  });
});
