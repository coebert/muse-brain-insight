import { describe, expect, it } from "vitest";
import {
  deriveClinicalCovariates,
  toggleCondition,
  validateClinicalCovariates,
  NONE_KEY,
} from "./clinical-covariates";
import { covariateLevels } from "./covariates";

describe("clinical covariates", () => {
  it("rejects unknown keys and duplicate entries", () => {
    const res = validateClinicalCovariates({
      chronicConditions: ["dementia", "dementia", "made_up"],
      acutePathology: [],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.chronicConditions.length).toBeGreaterThan(0);
    expect(res.value.chronicConditions).toEqual(["dementia"]);
  });

  it("keeps None mutually exclusive", () => {
    expect(toggleCondition(["dementia"], NONE_KEY)).toEqual([NONE_KEY]);
    expect(toggleCondition([NONE_KEY], "ckd")).toEqual(["ckd"]);
    const res = validateClinicalCovariates({
      chronicConditions: [NONE_KEY, "ckd"],
      acutePathology: [],
    });
    expect(res.ok).toBe(false);
  });

  it("derives coarse levels the model can learn from", () => {
    const derived = deriveClinicalCovariates({
      chronicConditions: ["dementia", "ckd", "copd"],
      acutePathology: ["sepsis", "tbi"],
    });
    expect(derived).toEqual({
      chronicBurden: "high",
      chronicCns: "present",
      acuteClass: "mixed",
    });
  });

  it("distinguishes not-recorded from explicitly none", () => {
    expect(deriveClinicalCovariates({ chronicConditions: [], acutePathology: [] })).toEqual({
      chronicBurden: null,
      chronicCns: null,
      acuteClass: null,
    });
    expect(
      deriveClinicalCovariates({ chronicConditions: [NONE_KEY], acutePathology: [NONE_KEY] }),
    ).toEqual({ chronicBurden: "none", chronicCns: "absent", acuteClass: "none" });
  });

  it("feeds the covariate design matrix", () => {
    const levels = covariateLevels({
      ageBand: "75-89",
      sex: "female",
      ...deriveClinicalCovariates({ chronicConditions: ["ckd"], acutePathology: ["sepsis"] }),
    });
    expect(levels).toContainEqual(["chronic", "single"]);
    expect(levels).toContainEqual(["acute", "systemic"]);
  });
});
