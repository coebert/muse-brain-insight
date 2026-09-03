import { describe, expect, it } from "vitest";

import { dose1Covariates, labelFromMoaas, parseDose1PeegCsv } from "../dose1-peeg";

const HEADER =
  "Time,abs_subdelta,abs_delta1,abs_delta2,abs_theta,abs_alpha,abs_beta1,abs_beta2,abs_gamma,MF,SEF95,Propofol,MOAAS,SOC";

function row(t: string, alpha: number, sef: number, moaas: number | "", propofol: number | "") {
  return `${t},1.0,2.6,1.6,0.2,${alpha},-1.5,-2.2,-2.7,8.5,${sef},${propofol},${moaas},1`;
}

const CSV = [
  HEADER,
  // Leading row with no band powers, as the published files start.
  "2022-01-01 00:02:17,,,,,,,,,,,,,",
  row("2022-01-01 00:02:18", -0.9, 12.5, 5, 0),
  row("2022-01-01 00:02:19", 0.4, 9.75, 3, 40),
  row("2022-01-01 00:02:20", 1.2, 7.5, 1, 90),
].join("\n");

describe("DOSE-I pEEG feature files", () => {
  it("keeps only rows with band powers and dates them from the clock", () => {
    const parsed = parseDose1PeegCsv(CSV, { caseRef: "10-013-peeg" });
    expect(parsed.epochs).toHaveLength(3);
    expect(parsed.skipped).toBe(1);
    expect(parsed.epochs.map((e) => e.atSeconds)).toEqual([0, 1, 2]);
    expect(parsed.epochs[0]!.externalRef).toBe("zenodo-dose-i:10-013-peeg:0.000");
  });

  it("uses the published SEF95 and never claims suppression", () => {
    const [first, , last] = parseDose1PeegCsv(CSV, { caseRef: "c" }).epochs;
    expect(first!.sef95).toBe(12.5);
    expect(last!.sef95).toBe(7.5);
    expect(parseDose1PeegCsv(CSV, { caseRef: "c" }).epochs.every((e) => !e.isSuppressed)).toBe(true);
    expect(parseDose1PeegCsv(CSV, { caseRef: "c" }).epochs.every((e) => e.suppressionRatio === 0)).toBe(
      true,
    );
  });

  it("maps MOAA/S onto the shared depth vocabulary", () => {
    expect(labelFromMoaas(5)).toBe("awake");
    expect(labelFromMoaas(3)).toBe("sedated");
    expect(labelFromMoaas(0)).toBe("anaesthetised");
    expect(labelFromMoaas(null)).toBeNull();
    const labels = parseDose1PeegCsv(CSV, { caseRef: "c" }).epochs.map((e) => e.label);
    expect(labels).toEqual(["awake", "sedated", "anaesthetised"]);
  });

  it("tracks alpha power rising with deepening sedation", () => {
    const epochs = parseDose1PeegCsv(CSV, { caseRef: "c" }).epochs;
    expect(epochs[2]!.bands.alpha).toBeGreaterThan(epochs[0]!.bands.alpha);
    expect(epochs[0]!.spectrumDb).toHaveLength(60);
    expect(epochs[0]!.spectrumDb.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("records file-level covariates for the sedation lineage", () => {
    const parsed = parseDose1PeegCsv(CSV, { caseRef: "c" });
    expect(dose1Covariates(parsed)).toMatchObject({
      setting: "procedural_sedation",
      regimen: "propofol_only",
      propofol_max_mg: 90,
      moaas_min: 1,
      moaas_max: 5,
    });
  });

  it("rejects a file with no band-power columns", () => {
    expect(() => parseDose1PeegCsv("Time,MF\n2022-01-01 00:00:00,8", { caseRef: "c" })).toThrow(
      /band-power/i,
    );
  });
});
