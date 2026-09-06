import { describe, expect, it } from "vitest";

import type { CohortCase, DepthExposure } from "@/lib/eeg/case-outcomes";
import { predictOutcome, wilson } from "@/lib/eeg/outcome-risk";

function exposure(deep: number, supp: number): DepthExposure {
  return {
    caseRef: "x",
    readings: 100,
    minutes: 100,
    meanIndex: 45,
    minIndex: 30,
    minutesBelow40: deep * 100,
    minutesBelow30: 0,
    minutesAbove60: 0,
    minutesSuppressed: supp * 100,
    fractionBelow40: deep,
    fractionBelow30: 0,
    fractionSuppressed: supp,
  };
}

function cohort(): CohortCase[] {
  return Array.from({ length: 40 }, (_, i) => {
    const deep = i / 40;
    return {
      caseRef: `c${i}`,
      exposure: exposure(deep, deep / 2),
      outcome: {
        caseRef: `c${i}`,
        inHospitalDeath: false,
        icuDays: deep > 0.5 ? 3 : 0,
        hospitalDays: 5 + i * 0.5,
        emergency: false,
        asa: "2",
        ageYears: 60,
        sex: "m",
        department: "General",
        optype: "Colorectal",
        approach: "Open",
        comorbidities: [],
      },
    };
  });
}

describe("outcome risk", () => {
  it("bounds the Wilson interval inside 0-1", () => {
    const i = wilson(0, 12)!;
    expect(i.low).toBe(0);
    expect(i.high).toBeGreaterThan(0);
    expect(i.high).toBeLessThan(1);
  });

  it("gives a higher intensive-care rate to a deeper case", () => {
    const cases = cohort();
    const light = predictOutcome(
      { caseRef: "a", label: "A", minutes: 100, meanIndex: 55, minutesBelow40: 2, minutesSuppressed: 0 },
      cases,
    )!;
    const deep = predictOutcome(
      { caseRef: "b", label: "B", minutes: 100, meanIndex: 32, minutesBelow40: 90, minutesSuppressed: 45 },
      cases,
    )!;
    expect(light.rates[0]!.rate!).toBeLessThan(deep.rates[0]!.rate!);
    expect(deep.percentileBelow40).toBeGreaterThan(light.percentileBelow40!);
  });

  it("returns null when the cohort has no confirmed outcomes", () => {
    const cases = cohort().map((c) => ({ ...c, outcome: null }));
    expect(predictOutcome({ caseRef: "a", label: "A", minutes: 10, meanIndex: 40, minutesBelow40: 1, minutesSuppressed: 0 }, cases)).toBeNull();
  });
});
