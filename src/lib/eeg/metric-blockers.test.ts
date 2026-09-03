import { describe, expect, it } from "vitest";

import {
  explainAgreementGaps,
  explainDriftGaps,
  explainVersionMetricGaps,
} from "./metric-blockers";
import type { ModelVersionRow, LineageHistory } from "./coebis-refit.functions";
import type { LineageDrift } from "./coebis-drift";
import type { BisDriftAnalysis } from "./bis-drift";

function versionRow(overrides: Partial<ModelVersionRow> = {}): ModelVersionRow {
  return {
    id: "v1",
    lineageKey: "muse-2|AF7-AF8|256",
    version: 1,
    modelFamily: "coebis",
    promoted: false,
    isActive: false,
    reason: null,
    maeGain: null,
    createdAt: "2026-09-01T00:00:00Z",
    runId: null,
    dataDigest: "abc",
    coefficients: {} as ModelVersionRow["coefficients"],
    training: { n: 40, cases: 3, folds: 3 },
    before: { mae: 10.7, n: 40 },
    after: { mae: 10.5, n: 40 },
    ...overrides,
  };
}

describe("explainVersionMetricGaps", () => {
  it("returns nothing when both sides are scored", () => {
    expect(explainVersionMetricGaps(versionRow({ maeGain: -0.2 }))).toEqual([]);
  });

  it("explains a missing before MAE with the paired-reading count", () => {
    const blockers = explainVersionMetricGaps(
      versionRow({ before: { mae: null, n: 0 }, maeGain: null }),
    );
    const before = blockers.find((b) => b.metric === "Before MAE");
    expect(before?.reason).toContain("0 readings");
    expect(before?.reason).toMatch(/paired EEG-index/i);
    expect(blockers.some((b) => b.metric === "Gain")).toBe(true);
  });

  it("explains a missing after MAE caused by a single case", () => {
    const blockers = explainVersionMetricGaps(
      versionRow({ after: { mae: null }, training: { n: 12, cases: 1, folds: 0 }, maeGain: null }),
    );
    const after = blockers.find((b) => b.metric === "After MAE (held out)");
    expect(after?.reason).toContain("12 readings across 1 case");
    expect(after?.reason).toContain("at least 2 cases");
  });

  it("cites the stop reason when cases are sufficient but scoring still absent", () => {
    const blockers = explainVersionMetricGaps(
      versionRow({
        after: { mae: null },
        training: { n: 60, cases: 4, folds: 4 },
        reason: "insufficient valid folds",
        maeGain: null,
      }),
    );
    const after = blockers.find((b) => b.metric === "After MAE (held out)");
    expect(after?.reason).toContain("insufficient valid folds");
  });
});

describe("explainDriftGaps", () => {
  const baseDrift: LineageDrift = {
    lineageKey: "l1",
    baseline: null,
    current: null,
    refits: 0,
    status: "baseline",
    maeDelta: null,
    biasDelta: null,
    cccDelta: null,
    baselineMae: null,
    currentMae: null,
    maxWeightDrift: null,
    rmsWeightDrift: null,
    topMovers: [],
    note: "",
  };
  const lineage = (versions: ModelVersionRow[]): LineageHistory => ({
    lineageKey: "l1",
    activeVersion: null,
    versions,
    latest: versions[versions.length - 1] ?? null,
  });

  it("names the single-version block with its count", () => {
    const blockers = explainDriftGaps(lineage([versionRow()]), baseDrift);
    expect(blockers.find((b) => b.metric === "Δ MAE")?.reason).toContain(
      "Only 1 model version",
    );
    expect(blockers.some((b) => b.metric === "Weight drift")).toBe(true);
  });

  it("explains an unscored baseline when two versions exist", () => {
    const blockers = explainDriftGaps(lineage([versionRow(), versionRow({ version: 2 })]), {
      ...baseDrift,
      refits: 1,
      baselineMae: null,
      currentMae: 10.5,
    });
    const mae = blockers.find((b) => b.metric === "Δ MAE");
    expect(mae?.reason).toMatch(/baseline version has no held-out MAE/i);
    expect(mae?.reason).toContain("10.50");
  });

  it("explains an unscored current model with its training counts", () => {
    const current = versionRow({ version: 2, training: { n: 15, cases: 1 } });
    const blockers = explainDriftGaps(lineage([versionRow(), current]), {
      ...baseDrift,
      refits: 1,
      baselineMae: 10.7,
      currentMae: null,
      current,
    });
    const mae = blockers.find((b) => b.metric === "Δ MAE");
    expect(mae?.reason).toContain("15 readings across 1 case");
    expect(mae?.reason).toContain("10.70");
  });

  it("returns nothing when drift is computable", () => {
    const blockers = explainDriftGaps(lineage([versionRow(), versionRow({ version: 2 })]), {
      ...baseDrift,
      refits: 1,
      maeDelta: 0.2,
      baselineMae: 10.7,
      currentMae: 10.9,
      maxWeightDrift: 0.8,
    });
    expect(blockers).toEqual([]);
  });
});

describe("explainAgreementGaps", () => {
  const analysis = (overrides: Partial<BisDriftAnalysis>): BisDriftAnalysis =>
    ({
      n: 0,
      nReliable: 0,
      sessions: 0,
      bias: null,
      sd: null,
      ci: null,
      designEffect: null,
      icc: null,
      nTransitional: 0,
      mae: null,
      r: null,
      bands: [],
      recent: { n: 0, bias: null },
      fit: null,
      verdict: "insufficient",
      tier: "none",
      summary: "",
      readiness: {
        points: { have: 0, need: 30 },
        sessions: { have: 0, need: 3 },
        provisional: { points: 8, sessions: 2, met: false },
        biasSignificant: false,
      },
      ...overrides,
    }) as BisDriftAnalysis;

  it("explains missing MAE as no paired EEG-index↔BIS readings, with counts", () => {
    const blockers = explainAgreementGaps(analysis({}));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toContain("0 paired across 0 cases");
    expect(blockers[0].reason).toMatch(/paired EEG-index/i);
  });

  it("explains missing correlation when fewer than 3 pairs exist", () => {
    const blockers = explainAgreementGaps(
      analysis({ n: 2, sessions: 1, mae: 8.1, bias: 3, r: null }),
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0].metric).toBe("Pearson r");
    expect(blockers[0].reason).toContain("only 2 available across 1 case");
  });

  it("returns nothing once MAE and r both exist", () => {
    expect(explainAgreementGaps(analysis({ n: 5, sessions: 2, mae: 7, r: 0.8 }))).toEqual([]);
  });
});
