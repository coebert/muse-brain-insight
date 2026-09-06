import { describe, expect, it } from "vitest";

import type { CohortCase, DepthExposure } from "@/lib/eeg/case-outcomes";
import { cohortPosition, percentileOf } from "@/lib/eeg/cohort-position";

function exposure(minutesBelow40: number, minutesSuppressed: number): DepthExposure {
  return {
    caseRef: "x",
    readings: 100,
    minutes: 120,
    meanIndex: 45,
    minIndex: 30,
    minutesBelow40,
    minutesBelow30: 0,
    minutesAbove60: 0,
    minutesSuppressed,
    fractionBelow40: minutesBelow40 / 120,
    fractionBelow30: 0,
    fractionSuppressed: minutesSuppressed / 120,
  };
}

function cohort(count: number, icuFrom: number): CohortCase[] {
  return Array.from({ length: count }, (_, i) => ({
    caseRef: `c-${i}`,
    exposure: exposure(i, i / 2),
    outcome: {
      caseRef: `c-${i}`,
      inHospitalDeath: false,
      icuDays: i >= icuFrom ? 2 : 0,
      hospitalDays: 5,
      emergency: false,
      asa: "2",
      ageYears: 60,
      sex: "m",
      department: "General surgery",
      optype: "Colectomy",
      approach: "Open",
      comorbidities: [],
    },
  }));
}

describe("percentileOf", () => {
  it("places a value inside the distribution", () => {
    expect(percentileOf(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(50);
    expect(percentileOf(0, [1, 2, 3, 4])).toBe(0);
    expect(percentileOf(100, [1, 2, 3, 4])).toBe(100);
  });

  it("returns null with nothing to compare against", () => {
    expect(percentileOf(5, [])).toBeNull();
  });
});

describe("cohortPosition", () => {
  it("returns null when the cohort is empty", () => {
    expect(cohortPosition(exposure(10, 5), [])).toBeNull();
  });

  it("places a light case as typical", () => {
    const pos = cohortPosition(exposure(0, 0), cohort(40, 20))!;
    expect(pos.band).toBe("typical");
    expect(pos.score).toBeLessThan(60);
    expect(pos.cohortCases).toBe(40);
  });

  it("places a deep, suppressed case well above the cohort", () => {
    const pos = cohortPosition(exposure(90, 60), cohort(40, 20))!;
    expect(pos.band).toBe("well-above");
    expect(pos.score).toBe(100);
  });

  it("reports the intensive-care arms separately", () => {
    const pos = cohortPosition(exposure(10, 5), cohort(40, 20))!;
    expect(pos.icuCases).toBe(20);
    expect(pos.withOutcome).toBe(40);
    expect(pos.readable).toBe(true);
    expect(pos.suppressed.icuMean).toBeGreaterThan(pos.suppressed.noIcuMean!);
  });

  it("marks the comparison unreadable when an arm is too small", () => {
    const pos = cohortPosition(exposure(10, 5), cohort(40, 38))!;
    expect(pos.readable).toBe(false);
  });

  it("treats a case with no readings as zero exposure", () => {
    const pos = cohortPosition(null, cohort(40, 20))!;
    expect(pos.below40.minutes).toBe(0);
    expect(pos.headline).toContain("No readings yet");
  });
});
