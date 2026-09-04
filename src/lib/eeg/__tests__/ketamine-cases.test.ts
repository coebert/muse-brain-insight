import { describe, expect, it } from "vitest";

import {
  ANAESTHESIA_THRESHOLD,
  featuresFromBands,
  summariseKetamineCases,
  type KetamineCaseEpoch,
} from "@/lib/eeg/ketamine-cases";

function epoch(over: Partial<KetamineCaseEpoch> = {}): KetamineCaseEpoch {
  return {
    lineage: "test|AF7|125",
    caseRef: "case-1",
    atSeconds: 0,
    features: {
      betaFraction: 0.22,
      gammaFraction: 0.12,
      alphaFraction: 0.05,
      slowFraction: 0.45,
    },
    coebis: 88,
    suppressionPct: 0,
    suppressionLabel: null,
    stateLabel: null,
    declared: true,
    ...over,
  };
}

describe("summariseKetamineCases", () => {
  it("reports a declared ketamine case as correcting, with threshold crossings", () => {
    const report = summariseKetamineCases([epoch(), epoch({ atSeconds: 4 })]);
    const row = report.cases[0]!;
    expect(row.effect).toBe("correcting");
    expect(row.correctedEpochs).toBe(2);
    expect(row.meanDelta).toBeLessThan(0);
    expect(row.crossings).toBe(2);
    expect(report.totals.correctingCases).toBe(1);
  });

  it("never moves an undeclared case, but flags the pattern as advisory", () => {
    const report = summariseKetamineCases([epoch({ declared: false })]);
    const row = report.cases[0]!;
    expect(row.effect).toBe("advisory");
    expect(row.correctedEpochs).toBe(0);
    expect(row.meanDelta).toBeNull();
    expect(row.crossings).toBe(0);
    expect(report.totals.declaredCases).toBe(0);
  });

  it("marks a declared case with no fast-frequency pattern as watched", () => {
    const flat = epoch({
      features: {
        betaFraction: 0.05,
        gammaFraction: 0.02,
        alphaFraction: 0.3,
        slowFraction: 0.5,
      },
    });
    expect(summariseKetamineCases([flat]).cases[0]!.effect).toBe("watched");
  });

  it("counts no crossing when the index is already below the anaesthesia threshold", () => {
    const deep = epoch({ coebis: ANAESTHESIA_THRESHOLD - 5 });
    const row = summariseKetamineCases([deep]).cases[0]!;
    expect(row.crossings).toBe(0);
  });

  it("grades suppression against the recorded reference", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      epoch({
        atSeconds: i,
        suppressionPct: i < 15 ? 40 : 0,
        suppressionLabel: i < 15 ? "suppressed" : "not_suppressed",
      }),
    );
    const grade = summariseKetamineCases(rows).cases[0]!.suppression;
    expect(grade.labelled).toBe(30);
    expect(grade.suppressed).toBe(15);
    expect(grade.concordance).toBe(1);
    expect(grade.grade).toBe("agrees");
  });

  it("withholds a suppression grade when too few epochs are labelled", () => {
    const rows = [epoch({ suppressionLabel: "suppressed", suppressionPct: 30 })];
    expect(summariseKetamineCases(rows).cases[0]!.suppression.grade).toBe("insufficient");
  });

  it("grades depth state only with both arms populated", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) =>
        epoch({ atSeconds: i, coebis: 40, stateLabel: "anaesthetised" }),
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        epoch({ atSeconds: 100 + i, coebis: 92, stateLabel: "awake" }),
      ),
    ];
    const state = summariseKetamineCases(rows).cases[0]!.state;
    expect(state.separation).toBeCloseTo(52, 5);
    expect(state.grade).toBe("separates");

    const oneArm = summariseKetamineCases(rows.slice(0, 12)).cases[0]!.state;
    expect(oneArm.grade).toBe("insufficient");
  });

  it("orders correcting cases ahead of advisory and quiet ones", () => {
    const report = summariseKetamineCases([
      epoch({ caseRef: "quiet", declared: false, features: featuresFromBands({ delta: 900, theta: 200, alpha: 300, beta: 20, gamma: 5 }) }),
      epoch({ caseRef: "advisory", declared: false }),
      epoch({ caseRef: "correcting" }),
    ]);
    expect(report.cases.map((c) => c.caseRef)).toEqual(["correcting", "advisory", "quiet"]);
  });
});

describe("featuresFromBands", () => {
  it("converts stored band powers to spectral shares", () => {
    const f = featuresFromBands({ delta: 500, theta: 200, alpha: 100, beta: 150, gamma: 50 });
    expect(f.betaFraction).toBeCloseTo(0.15, 5);
    expect(f.gammaFraction).toBeCloseTo(0.05, 5);
    expect(f.alphaFraction).toBeCloseTo(0.1, 5);
    expect(f.slowFraction).toBeCloseTo(0.5, 5);
  });

  it("returns nulls rather than guesses when bands are missing", () => {
    expect(featuresFromBands(null).betaFraction).toBeNull();
    expect(featuresFromBands({ delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }).betaFraction).toBeNull();
  });
});
