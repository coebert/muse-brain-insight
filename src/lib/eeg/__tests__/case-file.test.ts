import { describe, expect, it } from "vitest";

import { buildCaseFile, caseOptions, compareCases, matchKetamine } from "../case-file";
import type { SuppressionPoint } from "../suppression-model";
import type { KetamineCaseSummary } from "../ketamine-cases";

function point(over: Partial<SuppressionPoint> = {}): SuppressionPoint {
  return {
    caseRef: "case-1",
    atSeconds: 0,
    appSr: 0,
    bisSr: 0,
    appIndex: 50,
    bis: 50,
    sqi: 0.9,
    reliable: true,
    ...over,
  };
}

function summary(over: Partial<KetamineCaseSummary> = {}): KetamineCaseSummary {
  return {
    lineage: "vitaldb",
    caseRef: "case-1",
    epochs: 100,
    declared: true,
    evidence: "filed",
    effect: "correcting",
    meanBetaGamma: 0.3,
    maxBetaGamma: 0.5,
    meanAlpha: 0.2,
    meanSlow: 0.4,
    meanScore: 0.5,
    maxScore: 0.8,
    patternFraction: 0.4,
    correctedEpochs: 20,
    meanDelta: -3,
    maxDelta: -8,
    crossings: 2,
    suppression: {
      labelled: 0,
      suppressed: 0,
      appMeanSr: null,
      concordance: null,
      grade: "insufficient",
    },
    state: {
      anaesthetised: 0,
      awake: 0,
      meanAnaesthetised: null,
      meanAwake: null,
      separation: null,
      grade: "insufficient",
    },
    ...over,
  };
}

describe("case file", () => {
  it("puts the trace and the drug signature on the same case", () => {
    const file = buildCaseFile(
      "case-1",
      [point(), point({ atSeconds: 10, appIndex: 40 })],
      null,
      [summary()],
    );
    expect(file.trace?.points).toBe(2);
    expect(file.ketamine?.declared).toBe(true);
  });

  it("shows a case with no readings rather than pretending it is absent", () => {
    const file = buildCaseFile("case-9", [point()], null, [summary({ caseRef: "case-9" })]);
    expect(file.trace).toBeNull();
    expect(file.ketamine?.caseRef).toBe("case-9");
  });

  it("refuses an ambiguous drug match rather than attaching another patient's record", () => {
    const many = [summary({ caseRef: "vitaldb-1" }), summary({ caseRef: "vitaldb-12" })];
    expect(matchKetamine("vitaldb-1", many)?.caseRef).toBe("vitaldb-1");
    expect(matchKetamine("vitaldb", many)).toBeNull();
  });

  it("leaves a difference blank when only one case carries the evidence", () => {
    const a = buildCaseFile("case-1", [point()], null, [summary()]);
    const b = buildCaseFile("case-2", [point({ caseRef: "case-2", bis: null })], null, []);
    const cmp = compareCases(a, b);
    const bisRow = cmp.rows.find((r) => r.label === "Mean BIS");
    expect(bisRow?.delta).toBeNull();
    expect(cmp.notes.join(" ")).toContain("case-2");
  });

  it("offers every case that carries readings or spectra", () => {
    const options = caseOptions(
      [point(), point({ caseRef: "case-2" })],
      [summary({ caseRef: "case-3" })],
    );
    expect(options.map((o) => o.caseRef).sort()).toEqual(["case-1", "case-2", "case-3"]);
    expect(options.find((o) => o.caseRef === "case-1")?.bisPoints).toBe(1);
  });
});
