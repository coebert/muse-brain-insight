import { describe, expect, it } from "vitest";

import {
  evaluatePathologyLabels,
  posteriorAtPrior,
  type LabelledEpoch,
} from "./pathology-labels";

function epoch(i: number, ictal: boolean, caseIdx: number): LabelledEpoch {
  return {
    lineage: "test:lineage",
    caseRef: `case-${caseIdx}`,
    atSeconds: i,
    labelSource: "dataset",
    seizure: ictal ? "ictal" : "interictal",
    cns: null,
    scores: {
      coebis: ictal ? 70 : 45,
      seizureScore: ictal ? 0.8 : 0.2,
      suppressionRatio: 0,
      sef95: ictal ? 20 : 12,
    },
  };
}

describe("evaluatePathologyLabels", () => {
  it("grades a separable seizure axis in the right direction", () => {
    const rows: LabelledEpoch[] = [];
    for (let c = 0; c < 6; c += 1) {
      for (let i = 0; i < 20; i += 1) rows.push(epoch(i, c < 3, c));
    }
    const result = evaluatePathologyLabels(rows);
    const axis = result.axes.find((a) => a.key === "seizure");
    expect(axis).toBeTruthy();
    expect(axis!.positives).toBe(60);
    expect(axis!.cases).toBe(6);

    const seizureScore = axis!.scores.find((s) => s.score === "seizureScore")!;
    expect(seizureScore.auc).toBeGreaterThan(0.9);
    expect(seizureScore.sufficiency).toBe("sufficient");
  });

  it("reports insufficiency rather than a number when one class is missing", () => {
    const rows = Array.from({ length: 50 }, (_, i) => epoch(i, false, i % 3));
    const result = evaluatePathologyLabels(rows);
    const axis = result.axes.find((a) => a.key === "seizure");
    expect(axis?.positives ?? 0).toBe(0);
    expect(result.notes.join(" ")).toMatch(/ictal|seizure/i);
  });

  it("keeps posterior value honest at a low prior", () => {
    const post = posteriorAtPrior(0.01, 0.9, 0.9);
    expect(post.ppv!).toBeLessThan(0.1);
    expect(post.npv!).toBeGreaterThan(0.99);
  });
});
