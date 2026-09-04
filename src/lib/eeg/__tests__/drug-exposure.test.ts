import { describe, expect, it } from "vitest";

import {
  ANAESTHETIC_INDEX,
  emptyDrugExposure,
  summariseDrugExposure,
  summariseExposureCase,
  type DrugExposureEpoch,
} from "../drug-exposure";
import type { DrugKey } from "../drug-signatures";

function epoch(over: Partial<DrugExposureEpoch> = {}): DrugExposureEpoch {
  return {
    lineage: "external:zenodo:dose-i",
    caseRef: "case-1",
    atSeconds: 0,
    features: {
      alphaFraction: 0.2,
      slowFraction: 0.4,
      betaFraction: 0.1,
      gammaFraction: 0.05,
      thetaFraction: 0.25,
    } as DrugExposureEpoch["features"],
    coebis: 45,
    suppressionPct: 0,
    suppressionLabel: null,
    stateLabel: null,
    declared: ["propofol"] as DrugKey[],
    ...over,
  };
}

function many(n: number, over: Partial<DrugExposureEpoch> = {}): DrugExposureEpoch[] {
  return Array.from({ length: n }, (_, i) => epoch({ atSeconds: i, ...over }));
}

describe("summariseExposureCase", () => {
  it("collects every declared agent in registry order", () => {
    const summary = summariseExposureCase([
      epoch({ declared: ["opioid"] }),
      epoch({ declared: ["propofol"] }),
    ]);
    expect(summary.drugs).toEqual(["propofol", "opioid"]);
    expect(summary.drugLabels).toEqual(["Propofol", "Opioid"]);
  });

  it("reports a case with no recorded agent as unexposed", () => {
    const summary = summariseExposureCase(many(5, { declared: [] }));
    expect(summary.drugs).toEqual([]);
    expect(summary.meanCorrection).toBeNull();
    expect(summary.correctedEpochs).toBe(0);
  });

  it("applies no correction for a reference agent", () => {
    const summary = summariseExposureCase(many(5, { declared: ["propofol"] }));
    expect(summary.correctedEpochs).toBe(0);
  });

  it("averages the index and counts anaesthetic-range epochs", () => {
    const summary = summariseExposureCase([
      epoch({ coebis: 40 }),
      epoch({ coebis: 60 }),
      epoch({ coebis: 95 }),
    ]);
    expect(summary.meanIndex).toBeCloseTo(65, 1);
    expect(summary.minIndex).toBe(40);
    expect(summary.anaestheticFraction).toBeCloseTo(2 / 3, 2);
    expect(ANAESTHETIC_INDEX).toBe(83);
  });

  it("summarises measured suppression", () => {
    const summary = summariseExposureCase([
      epoch({ suppressionPct: 0 }),
      epoch({ suppressionPct: 20 }),
    ]);
    expect(summary.meanSuppressionPct).toBeCloseTo(10, 1);
    expect(summary.suppressedFraction).toBeCloseTo(0.5, 2);
  });

  it("withholds grades when a case carries no independent labels", () => {
    const summary = summariseExposureCase(many(30));
    expect(summary.state.grade).toBe("insufficient");
    expect(summary.suppression.grade).toBe("insufficient");
  });

  it("grades depth-state separation when both arms are labelled", () => {
    const summary = summariseExposureCase([
      ...many(15, { stateLabel: "anaesthetised", coebis: 40 }),
      ...many(15, { stateLabel: "awake", coebis: 90 }),
    ]);
    expect(summary.state.grade).toBe("separates");
    expect(summary.state.separation).toBeCloseTo(50, 0);
  });

  it("marks a case where the index does not separate the two states", () => {
    const summary = summariseExposureCase([
      ...many(15, { stateLabel: "anaesthetised", coebis: 70 }),
      ...many(15, { stateLabel: "awake", coebis: 72 }),
    ]);
    expect(summary.state.grade).toBe("overlaps");
  });

  it("grades suppression agreement against the recorded label", () => {
    const summary = summariseExposureCase([
      ...many(15, { suppressionLabel: "suppressed", suppressionPct: 30 }),
      ...many(15, { suppressionLabel: "not_suppressed", suppressionPct: 0 }),
    ]);
    expect(summary.suppression.grade).toBe("agrees");
    expect(summary.suppression.concordance).toBe(1);
  });
});

describe("summariseDrugExposure", () => {
  const report = summariseDrugExposure([
    ...many(30, { caseRef: "a", declared: ["propofol"] }),
    ...many(30, { caseRef: "b", declared: ["propofol", "opioid"] }),
    ...many(30, { caseRef: "c", declared: ["propofol"] }),
    ...many(30, { caseRef: "d", declared: [] }),
  ]);

  it("counts each case once and separates the unexposed ones", () => {
    expect(report.totals.cases).toBe(4);
    expect(report.totals.exposedCases).toBe(3);
    expect(report.totals.unexposedCases).toBe(1);
  });

  it("pools cases into per-agent cohorts, sharing cases across agents", () => {
    const propofol = report.cohorts.find((c) => c.key === "propofol");
    const opioid = report.cohorts.find((c) => c.key === "opioid");
    expect(propofol?.cases).toBe(3);
    expect(opioid?.cases).toBe(1);
    expect(propofol?.comparable).toBe(true);
    expect(opioid?.comparable).toBe(false);
  });

  it("keeps a cohort for cases with no recorded agent", () => {
    const none = report.cohorts.find((c) => c.key === "none");
    expect(none?.cases).toBe(1);
    expect(none?.role).toBe("none");
  });

  it("explains the unexposed cases in the notes", () => {
    expect(report.notes.join(" ")).toContain("1 of 4 cases record no agent");
  });

  it("returns an empty report for an empty corpus", () => {
    const empty = emptyDrugExposure();
    expect(empty.cases).toEqual([]);
    expect(empty.cohorts).toEqual([]);
    expect(empty.totals.cases).toBe(0);
  });
});
