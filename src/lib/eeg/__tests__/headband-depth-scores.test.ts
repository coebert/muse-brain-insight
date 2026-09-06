import { describe, expect, it } from "vitest";

import {
  compareHeadbandToSuppression,
  scoreEpoch,
  type HeadbandEpoch,
} from "../headband-depth-scores";
import type { CoebisModel } from "../coebis-covariates";
import type { SuppressionModel } from "../suppression-model";

const depth: CoebisModel = {
  family: "linear",
  gain: 0.6,
  offset: 5,
  knots: [],
  terms: [],
  ceTerms: [],
  diagnostics: null,
  caseIntercepts: {},
  n: 21,
  sessions: 6,
} as unknown as CoebisModel;

const suppression: SuppressionModel = {
  intercept: 0,
  bSr: 1.2,
  bSqrtSr: 0,
  bIndexDeficit: 0,
  n: 500,
  cases: 8,
};

function epoch(over: Partial<HeadbandEpoch> = {}): HeadbandEpoch {
  return {
    sessionId: "s1",
    caseCode: "CASE-1",
    atSeconds: 0,
    rawIndex: 70,
    appSr: 0,
    ...over,
  };
}

describe("scoreEpoch", () => {
  it("applies the headband model to the open index", () => {
    const s = scoreEpoch(epoch({ rawIndex: 80 }), depth, suppression);
    expect(s.headbandIndex).toBeLessThan(80);
    expect(s.suppressed).toBe(false);
  });

  it("falls back to the open index when no headband model is promoted", () => {
    const s = scoreEpoch(epoch({ rawIndex: 55 }), null, suppression);
    expect(s.headbandIndex).toBe(55);
  });

  it("lets the suppression cap pull the score down, never up", () => {
    const s = scoreEpoch(epoch({ rawIndex: 90, appSr: 50 }), null, suppression);
    expect(s.estimatedSr).toBeGreaterThan(20);
    expect(s.cappedIndex).toBeLessThan(90);
    expect(s.capShift).toBeGreaterThan(0);
  });
});

describe("compareHeadbandToSuppression", () => {
  it("reports nothing readable with no epochs", () => {
    const r = compareHeadbandToSuppression([], depth, suppression);
    expect(r.epochs).toBe(0);
    expect(r.verdict).toMatch(/No scored/);
  });

  it("counts suppressed epochs and concordance with deep scores", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => epoch({ atSeconds: i, rawIndex: 20, appSr: 40 })),
      ...Array.from({ length: 10 }, (_, i) =>
        epoch({ sessionId: "s2", atSeconds: i, rawIndex: 85, appSr: 0 }),
      ),
    ];
    const r = compareHeadbandToSuppression(rows, null, suppression);
    expect(r.epochs).toBe(20);
    expect(r.cases).toBe(2);
    expect(r.suppressedEpochs).toBe(10);
    expect(r.concordance).toBe(1);
    expect(r.contradictionShare).toBe(0);
  });

  it("flags contradictions where the record is flat but the score reads light", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      epoch({ atSeconds: i, rawIndex: 85, appSr: 40 }),
    );
    const r = compareHeadbandToSuppression(rows, null, suppression);
    expect(r.suppressedEpochs).toBe(8);
    expect(r.contradictionShare).toBe(1);
    expect(r.verdict).toMatch(/too light at depth/);
    expect(r.cases_[0]!.contradictions).toBe(8);
  });

  it("marks small groups as not readable", () => {
    const rows = [epoch({ appSr: 40 }), epoch({ atSeconds: 1 })];
    const r = compareHeadbandToSuppression(rows, null, suppression);
    expect(r.groups.every((g) => g.readable)).toBe(false);
  });

  it("records which models were actually in force", () => {
    const r = compareHeadbandToSuppression([epoch()], null, null);
    expect(r.depthSource).toBe("open_index");
    expect(r.suppressionSource).toBe("app_ratio");
  });
});
