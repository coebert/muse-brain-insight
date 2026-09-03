import { describe, expect, it } from "vitest";

import {
  ageBandOf,
  frailtyFromAsa,
  mapVitalDbCase,
  parseVitalDbClinicalCsv,
  parseVitalDbTrackCsv,
  regimenOf,
  summariseExternalPriors,
} from "./vitaldb";

const CLINICAL = `caseid,age,sex,asa,ane_type,intraop_ppf,intraop_ftn
1,68,M,3,General,120,100
2,31,F,1,Sedationalgesia,0,0
`;

function trackCsv(): string {
  const lines = ["Time,BIS/BIS,BIS/SEF,BIS/SR,BIS/EMG,BIS/SQI,Orchestra/PPF20_CE,Orchestra/RFTN20_CE"];
  for (let t = 0; t < 60; t++) {
    const bis = 40 + (t % 5);
    const sqi = t < 10 ? 20 : 95; // first 10 s poor quality
    lines.push(`${t},${bis},12.5,0,8,${sqi},3.2,3.0`);
  }
  lines.push("60,,,,,,,"); // sample with no BIS
  lines.push("61,140,,,,95,,"); // out of range
  return lines.join("\n");
}

describe("VitalDB import mapping", () => {
  it("parses the clinical table", () => {
    const cases = parseVitalDbClinicalCsv(CLINICAL);
    expect(cases.size).toBe(2);
    expect(cases.get("1")).toMatchObject({ age: 68, sex: "M", asa: "3", propofol: true });
  });

  it("maps ages, ASA and regimen into the app's vocabulary", () => {
    const info = parseVitalDbClinicalCsv(CLINICAL).get("1")!;
    expect(ageBandOf(68)).toBe("60-74");
    expect(frailtyFromAsa("3")).toBe("mild");
    expect(regimenOf(info, new Set(["propofol", "remifentanil"]))).toBe("propofol_opioid");
    const sedation = parseVitalDbClinicalCsv(CLINICAL).get("2")!;
    expect(regimenOf(sedation, new Set())).toBe("sedation_infusion");
  });

  it("filters unusable samples and reduces tracks onto a fixed stride", () => {
    const info = parseVitalDbClinicalCsv(CLINICAL).get("1")!;
    const samples = parseVitalDbTrackCsv(trackCsv());
    const mapped = mapVitalDbCase(info, samples, { strideSeconds: 10, minSqi: 50 });

    expect(mapped.rejected.lowSqi).toBe(10);
    expect(mapped.rejected.noBis).toBe(1);
    expect(mapped.rejected.badRange).toBe(1);
    // 50 usable seconds at a 10 s stride
    expect(mapped.points).toHaveLength(5);
    expect(mapped.points[0]!.atSeconds).toBe(10);
    expect(mapped.points[0]!.ce["propofol"]).toBeCloseTo(3.2, 2);
    expect(mapped.covariates).toMatchObject({
      ageBand: "60-74",
      sex: "male",
      regimen: "propofol_opioid",
      frailty: "mild",
    });
    expect(new Set(mapped.points.map((p) => p.externalRef)).size).toBe(5);
  });

  it("summarises priors per covariate level with case counts", () => {
    const summary = summariseExternalPriors([
      { caseRef: "a", bis: 40, ce: { propofol: 3 }, ageBand: "60-74", sex: "male", regimen: "propofol_opioid", frailty: "mild" },
      { caseRef: "a", bis: 44, ce: { propofol: 3.4 }, ageBand: "60-74", sex: "male", regimen: "propofol_opioid", frailty: "mild" },
      { caseRef: "b", bis: 52, ce: null, ageBand: "18-39", sex: "female", regimen: "sedation_infusion", frailty: null },
    ]);
    expect(summary.points).toBe(3);
    expect(summary.cases).toBe(2);
    const age = summary.groups.find((g) => g.group === "age" && g.level === "60-74")!;
    expect(age.n).toBe(2);
    expect(age.cases).toBe(1);
    expect(age.meanBis).toBe(42);
    expect(age.meanPropofolCe).toBeCloseTo(3.2, 2);
  });
});
