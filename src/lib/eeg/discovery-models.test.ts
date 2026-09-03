import { describe, expect, it } from "vitest";

import { discoverCovariateFeatures, type DiscoveryRow } from "./covariate-discovery";
import {
  MIN_ADOPTED_CASES,
  adoptLineageTerms,
  buildAdoptionLedger,
  isDeviceLineage,
} from "./discovery-adoption";
import {
  MIN_CASES_PER_CLASS,
  caseVectors,
  fitDiagnosisModel,
  fitDiagnosisModels,
  rocAuc,
  suggestDiagnosis,
} from "./diagnosis-model";

function features(sef: number, suppression: number, delta: number) {
  return {
    relDelta: delta,
    relTheta: 0.2,
    relAlpha: 0.9 - delta - 0.2 - 0.05 - 0.02,
    relBeta: 0.05,
    relGamma: 0.02,
    logTotalPower: 3 + delta,
    sef95: sef,
    suppressionRatio: suppression,
  };
}

/** Two clearly separated pathology classes, several cases each. */
function rows(lineage: string, perClass = 6): DiscoveryRow[] {
  const out: DiscoveryRow[] = [];
  for (let i = 0; i < perClass; i++) {
    for (const [pathology, sef, sup, delta] of [
      ["sepsis", 8, 0.3, 0.55],
      ["elective", 14, 0.02, 0.35],
    ] as const) {
      for (let e = 0; e < 5; e++) {
        out.push({
          lineage,
          caseRef: `${lineage}/${pathology}-${i}`,
          covariates: {
            pathology_category: pathology,
            age_band: pathology === "sepsis" ? "70-79" : "30-39",
            sex: i % 2 === 0 ? "M" : "F",
          },
          features: features(
            sef + (i % 3) * 0.2 + e * 0.01,
            sup + i * 0.002,
            delta + i * 0.002,
          ),
        });
      }
    }
  }
  return out;
}

describe("discovery adoption", () => {
  it("only device lineages may seed the COEBIS fit", () => {
    const external = discoverCovariateFeatures(rows("external:vitaldb"));
    const ledger = buildAdoptionLedger(external);
    expect(ledger.adoptedTotal).toBe(0);
    for (const l of ledger.lineages) {
      expect(l.deviceLineage).toBe(false);
      for (const t of l.terms) expect(t.state).toBe("evidence-only");
      expect(Object.keys(l.seed)).toHaveLength(0);
    }
  });

  it("adopts sufficient device-lineage terms with a seed offset", () => {
    const result = discoverCovariateFeatures(rows("app:muse-2"));
    const lineage = result.lineages[0]!;
    expect(lineage.candidates.length).toBeGreaterThan(0);
    const adoption = adoptLineageTerms(lineage);
    expect(adoption.deviceLineage).toBe(true);
    expect(adoption.adoptedCount).toBeGreaterThan(0);
    for (const [key, dy] of Object.entries(adoption.seed)) {
      expect(key).toContain(":");
      expect(Math.abs(dy)).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("holds device terms that lack independent cases and says why", () => {
    const result = discoverCovariateFeatures(rows("app:muse-2", 2));
    const adoption = adoptLineageTerms(result.lineages[0]!);
    expect(adoption.adoptedCount).toBe(0);
    for (const t of adoption.terms) {
      expect(t.state).toBe("held");
      expect(t.reason).toContain(String(MIN_ADOPTED_CASES));
    }
  });

  it("classifies lineage ownership", () => {
    expect(isDeviceLineage("app:muse-2")).toBe(true);
    expect(isDeviceLineage("external:openneuro:ds004541")).toBe(false);
  });
});

describe("diagnosis model", () => {
  it("aggregates epochs to one vector per case", () => {
    const vectors = caseVectors(rows("app:muse-2", 3), "pathology", [
      "sef95",
      "suppressionRatio",
    ]);
    expect(vectors).toHaveLength(6);
    expect(vectors[0]!.x).toHaveLength(2);
  });

  it("separates two labelled pathology classes under cross-validation", () => {
    const model = fitDiagnosisModel("app:muse-2", rows("app:muse-2"), "pathology");
    expect(model.cases).toBe(12);
    expect(model.classes).toHaveLength(2);
    expect(model.sufficiency).toBe("sufficient");
    expect(model.blocker).toBeNull();
    expect(model.accuracy).toBeGreaterThan(0.8);
    expect(model.balancedAccuracy).toBeGreaterThan(0.8);
    for (const c of model.classes) expect(c.auc).toBeGreaterThan(0.8);
  });

  it("flags an under-powered label set instead of claiming a diagnosis", () => {
    const model = fitDiagnosisModel("app:muse-2", rows("app:muse-2", 2), "pathology");
    expect(model.sufficiency).not.toBe("sufficient");
    expect(model.blocker).toContain(String(MIN_CASES_PER_CLASS));
  });

  it("returns a ranked suggestion with drivers for a live feature vector", () => {
    const model = fitDiagnosisModel("app:muse-2", rows("app:muse-2"), "pathology");
    const ranked = suggestDiagnosis(model, features(8.1, 0.3, 0.55));
    expect(ranked[0]!.level).toBe("sepsis");
    expect(ranked[0]!.posterior).toBeGreaterThan(0.5);
    expect(ranked[0]!.logLR).toBeGreaterThan(0);
    expect(ranked[0]!.drivers.length).toBeGreaterThan(0);
  });

  it("keeps lineages separate when fitting every group", () => {
    const models = fitDiagnosisModels([...rows("app:muse-2", 4), ...rows("external:vitaldb", 4)]);
    const lineages = new Set(models.map((m) => m.lineage));
    expect(lineages).toEqual(new Set(["app:muse-2", "external:vitaldb"]));
    for (const m of models) expect(m.group).toBeTruthy();
  });

  it("computes a rank-based AUC", () => {
    expect(rocAuc([0.1, 0.2, 0.8, 0.9], [false, false, true, true])).toBe(1);
    expect(rocAuc([1, 1, 1, 1], [true, false, true, false])).toBe(0.5);
    expect(rocAuc([1, 2], [false, false])).toBeNull();
  });
});
