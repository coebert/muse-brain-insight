import { describe, expect, it } from "vitest";
import {
  benchmarkIndexPaired,
  benchmarkReferenceOnly,
  benchmarkSpectralLabels,
  buildExternalValidationReport,
} from "./external-validation";
import { fitCoebisModel, type CoebisTrainingPoint } from "./coebis-covariates";

function trainingPoints(): CoebisTrainingPoint[] {
  const pts: CoebisTrainingPoint[] = [];
  for (let c = 0; c < 6; c++) {
    for (let i = 0; i < 12; i++) {
      const appIndex = 25 + i * 4;
      pts.push({
        sessionId: `case-${c}`,
        atSeconds: i * 60,
        appIndex,
        // Commercial monitor reads a little lower than the app index.
        bis: appIndex * 0.9 - 2,
        reliable: true,
        cov: { ageBand: "40-59", sex: "female", regimen: "propofol-remifentanil" },
      } as CoebisTrainingPoint);
    }
  }
  return pts;
}

describe("external validation", () => {
  const model = fitCoebisModel(trainingPoints(), "covariate")!;

  it("scores an index-paired lineage against the raw index baseline", () => {
    const points = Array.from({ length: 30 }, (_, i) => {
      const appIndex = 30 + i * 2;
      return {
        caseRef: `vd-${i % 5}`,
        appIndex,
        bis: appIndex * 0.9 - 2,
        cov: { ageBand: "40-59" },
      };
    });
    const b = benchmarkIndexPaired(model, "external:test", points);
    expect(b.kind).toBe("index-paired");
    expect(b.cases).toBe(5);
    expect(b.agreement!.mae!).toBeLessThan(b.baseline!.mae!);
  });

  it("scores a reference-only lineage on the covariate layer, centred on its own mean", () => {
    const b = benchmarkReferenceOnly(model, "external:vitaldb", [
      { caseRef: "a", bis: 45, cov: { ageBand: "40-59" } },
      { caseRef: "b", bis: 50, cov: { ageBand: "80+" } },
      { caseRef: "c", bis: 42, cov: { ageBand: "40-59" } },
    ]);
    expect(b.kind).toBe("reference-only");
    expect(b.n).toBe(3);
    // The flat lineage mean is the honest comparator.
    expect(b.baseline!.bias).toBe(0);
    expect(b.notes.join(" ")).toContain("No app index");
  });

  it("only treats dataset-published labels as ground truth", () => {
    const derived = benchmarkSpectralLabels("external:physionet", [
      {
        caseRef: "x",
        label: "burst_suppression",
        labelSource: "derived",
        suppressionRatio: 70,
        isSuppressed: true,
        sef95: 6,
      },
    ]);
    expect(derived.suppressionSensitivity).toBeNull();
    expect(derived.notes.join(" ")).toContain("derived");
  });

  it("computes suppression sensitivity, specificity and SEF ordering from labels", () => {
    const pts = [
      ...Array.from({ length: 10 }, (_, i) => ({
        caseRef: `p-${i}`,
        label: "burst_suppression",
        labelSource: "dataset" as const,
        suppressionRatio: 65,
        isSuppressed: true,
        sef95: 5,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        caseRef: `n-${i}`,
        label: "anaesthetised",
        labelSource: "dataset" as const,
        suppressionRatio: 2,
        isSuppressed: false,
        sef95: 14,
      })),
    ];
    const b = benchmarkSpectralLabels("external:physionet", pts);
    expect(b.suppressionSensitivity).toBe(1);
    expect(b.suppressionSpecificity).toBe(1);
    expect(b.suppressionRoc!.auc).toBe(1);
    expect(b.pk!.pk).toBe(1);
  });

  it("keeps lineages separate in the report", () => {
    const report = buildExternalValidationReport({ n: 72, cases: 6, family: "covariate" }, [
      benchmarkReferenceOnly(model, "external:vitaldb", [{ caseRef: "a", bis: 45 }]),
      benchmarkSpectralLabels("external:physionet", []),
    ]);
    expect(report.lineages).toHaveLength(2);
    expect(report.summary).toContain("never pooled");
  });
});
