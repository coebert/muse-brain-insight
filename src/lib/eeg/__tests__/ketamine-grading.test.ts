import { describe, expect, it } from "vitest";

import { gradedEpoch, gradeKetamineSubtraction } from "../ketamine-grading";
import type { KetamineCaseEpoch } from "../ketamine-cases";

/** Activated spectrum: the pattern the ketamine stage recognises. */
const fast = { betaFraction: 0.3, gammaFraction: 0.14, alphaFraction: 0.08, slowFraction: 0.35 };
/** Ordinary propofol spectrum: alpha spindle, slow-dominant, quiet fast. */
const calm = { betaFraction: 0.05, gammaFraction: 0.02, alphaFraction: 0.24, slowFraction: 0.5 };

function epoch(over: Partial<KetamineCaseEpoch>): KetamineCaseEpoch {
  return {
    lineage: "test",
    caseRef: "c1",
    atSeconds: 0,
    features: fast,
    coebis: 90,
    suppressionPct: 0,
    suppressionLabel: null,
    stateLabel: "anaesthetised",
    declared: true,
    ...over,
  };
}

describe("gradedEpoch", () => {
  it("returns the before/after pair, subtracting only when declared", () => {
    const declared = gradedEpoch(epoch({}))!;
    expect(declared.after).toBeLessThan(declared.before);
    const undeclared = gradedEpoch(epoch({ declared: false }))!;
    expect(undeclared.after).toBe(undeclared.before);
  });

  it("can force the declaration for the counterfactual arm", () => {
    const forced = gradedEpoch(epoch({ declared: false }), true)!;
    expect(forced.after).toBeLessThan(forced.before);
  });

  it("drops an epoch with no index", () => {
    expect(gradedEpoch(epoch({ coebis: null }))).toBeNull();
  });
});

describe("gradeKetamineSubtraction", () => {
  const declaredCase = [
    // Anaesthetised but reading spuriously light on the ketamine pattern.
    ...Array.from({ length: 12 }, (_, i) =>
      epoch({ caseRef: "k1", atSeconds: i, coebis: 88, stateLabel: "anaesthetised" }),
    ),
    // Genuinely awake epochs, no pattern.
    ...Array.from({ length: 12 }, (_, i) =>
      epoch({ caseRef: "k1", atSeconds: 100 + i, coebis: 95, features: calm, stateLabel: "awake" }),
    ),
  ];

  it("grades the declared arm before and after, and reports the AUC change", () => {
    const report = gradeKetamineSubtraction(declaredCase);
    const declared = report.arms.find((a) => a.arm === "declared")!;
    expect(declared.cases).toBe(1);
    expect(declared.moved).toBe(12);
    expect(declared.state.before.falselyLight).toBe(12);
    expect(declared.state.after.falselyLight).toBe(0);
    expect(declared.state.after.auc).toBeGreaterThan(declared.state.before.auc!);
    expect(declared.state.aucGain).toBeGreaterThan(0);
  });

  it("holds the declared arm below the reliability bar on a single case", () => {
    const declared = gradeKetamineSubtraction(declaredCase).arms.find((a) => a.arm === "declared")!;
    expect(declared.sufficiency).not.toBe("sufficient");
    expect(declared.verdict).toMatch(/orientation/);
  });

  it("leaves the app suppression concordance identical before and after", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      epoch({
        caseRef: "k1",
        atSeconds: i,
        coebis: 88,
        suppressionPct: 30,
        suppressionLabel: "suppressed",
        stateLabel: null,
      }),
    );
    const declared = gradeKetamineSubtraction(rows).arms.find((a) => a.arm === "declared")!;
    expect(declared.suppression.after.concordance).toBe(declared.suppression.before.concordance);
  });

  it("does not move the index inside recorded suppression", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      epoch({ caseRef: "k1", atSeconds: i, coebis: 40, suppressionPct: 45, suppressionLabel: "suppressed" }),
    );
    const declared = gradeKetamineSubtraction(rows).arms.find((a) => a.arm === "declared")!;
    expect(declared.moved).toBe(0);
  });

  it("routes patterned-but-undeclared cases to the counterfactual arm only", () => {
    const rows = declaredCase.map((e) => ({ ...e, caseRef: "u1", declared: false }));
    const report = gradeKetamineSubtraction(rows);
    expect(report.declaredCases).toBe(0);
    expect(report.patternedCases).toBe(1);
    expect(report.arms.find((a) => a.arm === "declared")!.epochs).toBe(0);
    const cf = report.arms.find((a) => a.arm === "counterfactual")!;
    expect(cf.moved).toBeGreaterThan(0);
    expect(cf.verdict).toMatch(/hypothetical/);
  });

  it("says plainly when no case records ketamine", () => {
    const report = gradeKetamineSubtraction([epoch({ declared: false, features: calm })]);
    expect(report.declaredCases).toBe(0);
    expect(report.notes[0]).toMatch(/No case currently in the pool records ketamine/);
    expect(report.arms.find((a) => a.arm === "declared")!.verdict).toMatch(/graded nothing/);
  });
});
