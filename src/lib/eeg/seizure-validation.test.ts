import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SEIZURE_VIGNETTES,
  runSeizureValidation,
  seizureValidationMarkdown,
} from "./seizure-validation";

describe("seizure detector validation pack", () => {
  const report = runSeizureValidation();

  it("scores every labelled vignette", () => {
    expect(report.results).toHaveLength(SEIZURE_VIGNETTES.length);
  });

  it("detects the majority of true ictal runs", () => {
    expect(report.sensitivity).toBeGreaterThanOrEqual(0.66);
  });

  it("does not alert on anaesthetic alpha, delta or burst suppression", () => {
    for (const id of ["anaesthetic-alpha", "slow-delta", "burst-suppression"]) {
      const r = report.results.find((x) => x.id === id)!;
      expect(`${id}:${r.alerted}`).toBe(`${id}:false`);
    }
  });

  it("keeps the false-alarm rate on artefact recordings bounded", () => {
    expect(report.falseAlarmsPerHour).toBeLessThan(60);
  });

  it("writes the markdown record", () => {
    const md = seizureValidationMarkdown(report);
    expect(md).toContain("Sensitivity");
    writeFileSync("src/lib/eeg/seizure-validation.md", md);
  });
});
