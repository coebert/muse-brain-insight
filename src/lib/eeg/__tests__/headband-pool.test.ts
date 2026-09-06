import { describe, expect, it } from "vitest";

import {
  buildHeadbandPool,
  classifyOutcome,
  refitHeadbandWithOutcomes,
  type CaseOutcomeRow,
} from "../headband-pool";
import type { CoebisTrainingPoint } from "../coebis-covariates";

const cov = {
  ageBand: null,
  sex: null,
  regimen: null,
  frailty: null,
  chronicBurden: null,
  chronicCns: null,
  acuteClass: null,
} as unknown as CoebisTrainingPoint["cov"];

function point(sessionId: string, appIndex: number, bis: number, i: number): CoebisTrainingPoint {
  return {
    at: i * 60,
    bis,
    appIndex,
    sessionId,
    reliable: true,
    sqi: 0.9,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    cov,
  } as CoebisTrainingPoint;
}

function outcome(over: Partial<CaseOutcomeRow>): CaseOutcomeRow {
  return {
    sessionId: "s",
    delirium: "none",
    emergence: "smooth",
    awareness: false,
    unplannedIcu: false,
    mortality30d: false,
    ...over,
  };
}

describe("classifyOutcome", () => {
  it("reads a missing record as unrecorded, never as clean", () => {
    expect(classifyOutcome(null)).toBe("unrecorded");
  });

  it("reads a recorded problem as adverse", () => {
    expect(classifyOutcome(outcome({ unplannedIcu: true }))).toBe("adverse");
    expect(classifyOutcome(outcome({ delirium: "day1" }))).toBe("adverse");
    expect(classifyOutcome(outcome({ awareness: true }))).toBe("adverse");
  });

  it("reads a recorded uneventful recovery as clean", () => {
    expect(classifyOutcome(outcome({}))).toBe("clean");
  });
});

describe("buildHeadbandPool", () => {
  const points = [point("a", 70, 50, 0), point("a", 60, 42, 1), point("b", 80, 60, 2)];
  const pool = buildHeadbandPool("muse-2|x|256", points, [
    { sessionId: "a", caseCode: "A", epochs: 100, meanDepth: 55, deepEpochs: 10, outcome: outcome({ sessionId: "a", unplannedIcu: true }) },
    { sessionId: "b", caseCode: "B", epochs: 90, meanDepth: 62, deepEpochs: 2, outcome: null },
    { sessionId: "c", caseCode: "C", epochs: 80, meanDepth: 70, deepEpochs: 0, outcome: null },
  ]);

  it("counts paired and unpaired recordings separately", () => {
    expect(pool.readings).toBe(3);
    expect(pool.pairedCases).toBe(2);
    expect(pool.unpairedCases).toBe(1);
  });

  it("counts only recordings that carry a recorded recovery", () => {
    expect(pool.casesWithOutcome).toBe(1);
    expect(pool.adverseCases).toBe(1);
  });
});

describe("refitHeadbandWithOutcomes", () => {
  const points = [
    ...Array.from({ length: 8 }, (_, i) => point("a", 70 + i, 50 + i, i)),
    ...Array.from({ length: 8 }, (_, i) => point("b", 68 + i, 48 + i, i + 8)),
    ...Array.from({ length: 8 }, (_, i) => point("c", 72 + i, 52 + i, i + 16)),
  ];
  const pool = buildHeadbandPool("muse-2|x|256", points, [
    { sessionId: "a", caseCode: "A", epochs: 100, meanDepth: 55, deepEpochs: 4, outcome: null },
    { sessionId: "b", caseCode: "B", epochs: 100, meanDepth: 55, deepEpochs: 4, outcome: null },
    { sessionId: "c", caseCode: "C", epochs: 100, meanDepth: 55, deepEpochs: 4, outcome: null },
  ]);

  it("grades every reading held out and splits it by outcome", () => {
    const fit = refitHeadbandWithOutcomes(pool, null);
    const total = fit.strata.reduce((a, s) => a + s.readings, 0);
    expect(total).toBe(points.length);
    expect(fit.strata.find((s) => s.outcome === "unrecorded")?.readings).toBe(points.length);
  });

  it("says plainly that no outcome has been recorded", () => {
    const fit = refitHeadbandWithOutcomes(pool, null);
    expect(fit.outcomeUsable).toBe(false);
    expect(fit.readingsWithOutcome).toBe(0);
    expect(fit.outcomeNote).toMatch(/No recovery has been recorded/);
  });

  it("marks the split readable once enough recoveries are recorded", () => {
    const withOutcomes = buildHeadbandPool("muse-2|x|256", points, [
      { sessionId: "a", caseCode: "A", epochs: 100, meanDepth: 55, deepEpochs: 4, outcome: outcome({ sessionId: "a", unplannedIcu: true }) },
      { sessionId: "b", caseCode: "B", epochs: 100, meanDepth: 55, deepEpochs: 4, outcome: outcome({ sessionId: "b" }) },
      { sessionId: "c", caseCode: "C", epochs: 100, meanDepth: 55, deepEpochs: 4, outcome: outcome({ sessionId: "c" }) },
    ]);
    const fit = refitHeadbandWithOutcomes(withOutcomes, null);
    expect(fit.outcomeUsable).toBe(true);
    expect(fit.readingsWithOutcome).toBe(points.length);
    expect(fit.strata.find((s) => s.outcome === "adverse")?.cases).toBe(1);
  });
});
