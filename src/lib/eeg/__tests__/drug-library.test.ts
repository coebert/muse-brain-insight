import { describe, expect, it } from "vitest";

import {
  emptyDrugLibrary,
  orderedLibrary,
  summariseDrugLibrary,
  type DrugLibraryEpoch,
} from "../drug-library";
import { DRUG_SPECS } from "../drug-signatures";

const gabaergic = {
  betaFraction: 0.06,
  gammaFraction: 0.02,
  alphaFraction: 0.24,
  slowFraction: 0.42,
};
const activated = {
  betaFraction: 0.3,
  gammaFraction: 0.16,
  alphaFraction: 0.06,
  slowFraction: 0.3,
};
const blank = {
  betaFraction: null,
  gammaFraction: null,
  alphaFraction: null,
  slowFraction: null,
};

function epoch(over: Partial<DrugLibraryEpoch>): DrugLibraryEpoch {
  return { lineage: "vitaldb", caseRef: "c1", features: gabaergic, declared: [], ...over };
}

describe("drug library", () => {
  it("lists every registered agent even with no data", () => {
    const report = emptyDrugLibrary();
    expect(report.entries).toHaveLength(DRUG_SPECS.length);
    expect(report.entries.every((e) => !e.covered)).toBe(true);
  });

  it("counts a case once per lineage however many epochs it contributes", () => {
    const report = summariseDrugLibrary([
      epoch({ caseRef: "c1", declared: ["propofol"] }),
      epoch({ caseRef: "c1", declared: ["propofol"] }),
      epoch({ caseRef: "c2", declared: ["propofol"] }),
    ]);
    const propofol = report.entries.find((e) => e.key === "propofol")!;
    expect(propofol.totalCases).toBe(2);
    expect(propofol.totalEpochs).toBe(3);
    expect(propofol.covered).toBe(true);
  });

  it("splits coverage across the lineages an agent appears in", () => {
    const report = summariseDrugLibrary([
      epoch({ lineage: "vitaldb", caseRef: "a", declared: ["ketamine"] }),
      epoch({ lineage: "dose-i", caseRef: "b", declared: ["ketamine"] }),
      epoch({ lineage: "dose-i", caseRef: "c", declared: ["ketamine"] }),
    ]);
    const ket = report.entries.find((e) => e.key === "ketamine")!;
    expect(ket.lineages.map((l) => [l.lineage, l.cases])).toEqual([
      ["dose-i", 2],
      ["vitaldb", 1],
    ]);
    expect(ket.totalCases).toBe(3);
  });

  it("leaves an agent uncovered when no case records it", () => {
    const report = summariseDrugLibrary([epoch({ declared: ["propofol"] })]);
    const xenon = report.entries.find((e) => e.key === "xenon")!;
    expect(xenon.covered).toBe(false);
    expect(xenon.totalCases).toBe(0);
    expect(xenon.lineages).toEqual([]);
  });

  it("counts an undeclared activated spectrum as pattern only, never as coverage", () => {
    const report = summariseDrugLibrary([
      epoch({ caseRef: "a", features: activated, declared: [] }),
    ]);
    const n2o = report.entries.find((e) => e.key === "nitrous_oxide")!;
    expect(n2o.covered).toBe(false);
    expect(n2o.patternOnlyCases).toBe(1);
  });

  it("does not raise a pattern-only count for the agent that is declared", () => {
    const report = summariseDrugLibrary([
      epoch({ caseRef: "a", features: activated, declared: ["nitrous_oxide"] }),
    ]);
    const n2o = report.entries.find((e) => e.key === "nitrous_oxide")!;
    expect(n2o.patternOnlyCases).toBe(0);
    expect(n2o.totalCases).toBe(1);
  });

  it("ignores spectrum-free coverage rows when averaging pattern strength", () => {
    const report = summariseDrugLibrary([
      epoch({ caseRef: "a", features: blank, declared: ["ketamine"] }),
    ]);
    const ket = report.entries.find((e) => e.key === "ketamine")!;
    expect(ket.totalCases).toBe(1);
    expect(ket.lineages[0]!.meanScore).toBeNull();
  });

  it("reports how many cases name no agent at all", () => {
    const report = summariseDrugLibrary([
      epoch({ caseRef: "a", declared: ["propofol"] }),
      epoch({ caseRef: "b", declared: [] }),
      epoch({ caseRef: "c", declared: [] }),
    ]);
    expect(report.totalCases).toBe(3);
    expect(report.undeclaredCases).toBe(2);
    expect(report.notes.some((n) => n.includes("name no agent at all"))).toBe(true);
  });

  it("warns when agents have a rule but no case behind it", () => {
    const report = summariseDrugLibrary([epoch({ declared: ["propofol"] })]);
    expect(report.notes.some((n) => n.includes("not recorded in any case held here"))).toBe(true);
  });

  it("always warns that a pattern is not a declaration", () => {
    const report = summariseDrugLibrary([]);
    expect(report.notes.some((n) => n.includes("never stands in for a declaration"))).toBe(true);
  });

  it("orders corrected agents with the most coverage first", () => {
    const report = summariseDrugLibrary([
      epoch({ caseRef: "a", declared: ["propofol"] }),
      epoch({ caseRef: "b", declared: ["propofol"] }),
      epoch({ caseRef: "c", declared: ["ketamine"] }),
    ]);
    const order = orderedLibrary(report.entries);
    expect(order[0]!.role).toBe("corrected");
    expect(order[0]!.key).toBe("ketamine");
    expect(order.at(-1)!.role).toBe("neutral");
  });

  it("exposes the regimen words each agent is recognised by", () => {
    const report = emptyDrugLibrary();
    const ket = report.entries.find((e) => e.key === "ketamine")!;
    expect(ket.terms).toContain("ketamine");
    expect(ket.terms).toContain("esketamine");
  });
});
