import { describe, expect, it } from "vitest";
import {
  cohortContrast,
  cohortContrasts,
  depthExposureOf,
  parseVitalDbOutcomeCsv,
  type CaseOutcome,
  type CohortCase,
} from "../case-outcomes";

const CSV = [
  "caseid,adm,dis,icu_days,death_inhosp,age,sex,asa,emop,department,optype,approach,preop_htn,preop_dm",
  "1,0,864000,2,0,64,M,3,0,General surgery,Colorectal,Open,1,0",
  "2,0,432000,0,1,71,F,4,1,Thoracic surgery,Lung,Videoscopic,0,1",
  "3,,,,,,,,,,,,,",
].join("\n");

describe("parseVitalDbOutcomeCsv", () => {
  it("reads confirmed outcomes and keys them by case ref", () => {
    const map = parseVitalDbOutcomeCsv(CSV);
    const one = map.get("1")!;
    expect(one.caseRef).toBe("vitaldb-1");
    expect(one.inHospitalDeath).toBe(false);
    expect(one.icuDays).toBe(2);
    expect(one.hospitalDays).toBe(10);
    expect(one.ageYears).toBe(64);
    expect(one.sex).toBe("m");
    expect(one.comorbidities).toEqual(["hypertension"]);

    const two = map.get("2")!;
    expect(two.inHospitalDeath).toBe(true);
    expect(two.emergency).toBe(true);
    expect(two.comorbidities).toEqual(["diabetes"]);
  });

  it("leaves unrecorded fields null rather than defaulting them to zero", () => {
    const three = parseVitalDbOutcomeCsv(CSV).get("3")!;
    expect(three.inHospitalDeath).toBeNull();
    expect(three.icuDays).toBeNull();
    expect(three.hospitalDays).toBeNull();
    expect(three.ageYears).toBeNull();
  });
});

describe("depthExposureOf", () => {
  it("weights exposure by time, not by sample count", () => {
    // 0-60s at 35, then 60-120s at 55, sampled unevenly on purpose.
    const readings = [
      { atSeconds: 0, index: 35 },
      { atSeconds: 10, index: 35 },
      { atSeconds: 20, index: 35 },
      { atSeconds: 30, index: 35 },
      { atSeconds: 40, index: 35 },
      { atSeconds: 50, index: 35 },
      { atSeconds: 60, index: 55 },
      { atSeconds: 90, index: 55 },
      { atSeconds: 120, index: 55 },
    ];
    const e = depthExposureOf("case-a", readings)!;
    expect(e.minutes).toBe(2);
    expect(e.minutesBelow40).toBe(1);
    expect(e.fractionBelow40).toBeCloseTo(0.5, 5);
    expect(e.minIndex).toBe(35);
    expect(e.meanIndex).toBe(45);
  });

  it("does not count a monitoring gap as time at that depth", () => {
    const e = depthExposureOf("case-b", [
      { atSeconds: 0, index: 20 },
      { atSeconds: 3600, index: 50 },
      { atSeconds: 3610, index: 50 },
    ])!;
    // The hour-long gap is capped at 30 seconds, not counted as an hour deep.
    expect(e.minutesBelow30).toBe(0.5);
  });

  it("counts recorded suppression separately from a low index", () => {
    const e = depthExposureOf("case-c", [
      { atSeconds: 0, index: 45, suppressionRatio: 12 },
      { atSeconds: 10, index: 45, suppressionRatio: 0 },
      { atSeconds: 20, index: 45, suppressionRatio: 0 },
    ])!;
    expect(e.minutesSuppressed).toBe(0.2); // 10 seconds, to one decimal place
    expect(e.minutesBelow40).toBe(0);
  });

  it("returns nothing for a case with no usable readings", () => {
    expect(depthExposureOf("case-d", [])).toBeNull();
  });
});

function outcome(over: Partial<CaseOutcome>): CaseOutcome {
  return {
    caseRef: "x",
    inHospitalDeath: null,
    icuDays: null,
    hospitalDays: null,
    emergency: null,
    asa: null,
    ageYears: null,
    sex: null,
    department: null,
    optype: null,
    approach: null,
    comorbidities: [],
    ...over,
  };
}

function cohortCase(ref: string, below40: number, met: boolean | null): CohortCase {
  return {
    caseRef: ref,
    exposure: depthExposureOf(ref, [
      { atSeconds: 0, index: 30 },
      { atSeconds: below40 * 60, index: 70 },
      { atSeconds: below40 * 60 + 600, index: 70 },
    ])!,
    outcome: outcome({ caseRef: ref, inHospitalDeath: met }),
  };
}

describe("cohortContrast", () => {
  it("splits cases by the recorded outcome and keeps unknowns out of both arms", () => {
    const c = cohortContrast(
      [cohortCase("a", 1, true), cohortCase("b", 1, false), cohortCase("c", 1, null)],
      "inHospitalDeath",
      "Died in hospital",
    );
    expect(c.withN).toBe(1);
    expect(c.withoutN).toBe(1);
    expect(c.unknownN).toBe(1);
  });

  it("marks a contrast underpowered when either arm is small", () => {
    const many = Array.from({ length: 20 }, (_, i) => cohortCase(`s${i}`, 1, false));
    expect(cohortContrast([...many, cohortCase("d", 1, true)], "inHospitalDeath", "x").underpowered).toBe(
      true,
    );
    const both = [
      ...Array.from({ length: 12 }, (_, i) => cohortCase(`s${i}`, 1, false)),
      ...Array.from({ length: 12 }, (_, i) => cohortCase(`d${i}`, 1, true)),
    ];
    expect(cohortContrast(both, "inHospitalDeath", "x").underpowered).toBe(false);
  });

  it("reports all three outcome contrasts", () => {
    expect(cohortContrasts([cohortCase("a", 1, true)]).map((c) => c.key)).toEqual([
      "inHospitalDeath",
      "icuStay",
      "longStay",
    ]);
  });
});
