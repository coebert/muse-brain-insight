import { describe, expect, it } from "vitest";

import { matchOutcomeRows, parseOutcomeExportCsv } from "@/lib/eeg/outcome-import";
import type { OutcomeCase } from "@/lib/eeg/outcomes";

const CSV = [
  "case_code,delirium,delirium_days,emergence,unplanned_icu,mortality_30d,los_days,notes",
  "CT-001,none,,Smooth,no,no,3,uneventful",
  "CT-002,Hypoactive delirium,2,Delayed,yes,no,11,",
  "CT-003,yes,1,agitated,1,0,7,",
].join("\n");

function caseOf(caseCode: string, withOutcome = false): OutcomeCase {
  return {
    sessionId: `id-${caseCode}`,
    caseCode,
    ageBand: null,
    durationMinutes: 60,
    meanDepth: 45,
    minutesDeep: 10,
    meanSr: 1,
    minutesSuppressed: 2,
    outcome: withOutcome
      ? {
          sessionId: `id-${caseCode}`,
          delirium: "none",
          deliriumDays: null,
          emergence: "smooth",
          awareness: false,
          unplannedIcu: false,
          mortality30d: false,
          lengthOfStayDays: null,
          notes: null,
        }
      : null,
  };
}

describe("parseOutcomeExportCsv", () => {
  it("reads a recovery export", () => {
    const { rows, issues } = parseOutcomeExportCsv(CSV);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ caseCode: "CT-001", delirium: "none", emergence: "smooth" });
    expect(rows[1]).toMatchObject({
      delirium: "hypoactive",
      deliriumDays: 2,
      emergence: "delayed",
      unplannedIcu: true,
      lengthOfStayDays: 11,
    });
    expect(rows[2]).toMatchObject({ delirium: "mixed", unplannedIcu: true, mortality30d: false });
  });

  it("refuses a file containing patient identifiers", () => {
    const { rows, issues } = parseOutcomeExportCsv("case_code,nhs_number\nCT-001,123");
    expect(rows).toHaveLength(0);
    expect(issues[0]).toContain("identifiers");
  });

  it("needs a case code column", () => {
    const { issues } = parseOutcomeExportCsv("delirium,los_days\nnone,3");
    expect(issues[0]).toContain("case_code");
  });

  it("flags duplicate and blank case codes", () => {
    const { rows, issues } = parseOutcomeExportCsv(
      "case_code,delirium\nCT-001,none\nCT-001,none\n,none",
    );
    expect(rows).toHaveLength(1);
    expect(issues).toHaveLength(2);
  });

  it("lists columns it does not use", () => {
    const { ignoredColumns } = parseOutcomeExportCsv("case_code,surgeon\nCT-001,Smith");
    expect(ignoredColumns).toEqual(["surgeon"]);
  });
});

describe("matchOutcomeRows", () => {
  it("matches by case code and reports the rest", () => {
    const { rows } = parseOutcomeExportCsv(CSV);
    const report = matchOutcomeRows(rows, [
      caseOf("CT-001"),
      caseOf("ct-002", true),
      caseOf("CT-009"),
    ]);
    expect(report.matched.map((m) => m.caseCode)).toEqual(["CT-001", "ct-002"]);
    expect(report.matched[1]!.replaces).toBe(true);
    expect(report.unmatched).toEqual(["CT-003"]);
    expect(report.stillMissing).toEqual(["CT-009"]);
  });
});
