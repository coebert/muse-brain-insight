import { describe, expect, it } from "vitest";

import type { CoebisModel, CoebisTrainingPoint } from "../coebis-covariates";
import { liveAccuracyForLineage, summariseLiveAccuracy } from "../lineage-live-accuracy";

function point(i: number, over: Partial<CoebisTrainingPoint> = {}): CoebisTrainingPoint {
  return {
    bis: 50,
    appIndex: 55,
    reliable: true,
    sqi: 0.9,
    sessionId: `case-${i % 4}`,
    recordedAt: `2026-01-0${(i % 8) + 1}T00:00:00.000Z`,
    cov: {},
    lineageKey: "muse-2|TP9|256",
    ...over,
  } as CoebisTrainingPoint;
}

const affine: CoebisModel = {
  family: "affine",
  gain: 1,
  offset: -5,
  knots: [],
  terms: [],
  ceTerms: [],
  diagnostics: null,
  caseIntercepts: {},
  n: 0,
  sessions: 0,
};

describe("liveAccuracyForLineage", () => {
  it("scores the uncorrected index when no model is in force", () => {
    const r = liveAccuracyForLineage("l", [point(1), point(2)], null, null);
    expect(r.source).toBe("raw_index");
    expect(r.current.mae).toBeCloseTo(5, 6);
    expect(r.maeGain).toBeNull();
  });

  it("reports the error the live model removes", () => {
    const r = liveAccuracyForLineage("l", [point(1), point(2)], { model: affine, version: 3 }, null);
    expect(r.source).toBe("model");
    expect(r.activeVersion).toBe(3);
    expect(r.current.mae).toBeCloseTo(0, 6);
    expect(r.maeGain).toBeCloseTo(5, 3);
  });

  it("drops readings the training filters reject", () => {
    const r = liveAccuracyForLineage(
      "l",
      [point(1), point(2, { reliable: false }), point(3, { sqi: 0.1 })],
      null,
      null,
    );
    expect(r.n).toBe(1);
    expect(r.rejected).toBe(2);
  });

  it("blocks a lineage below the gate and says what it needs", () => {
    const r = liveAccuracyForLineage("l", [point(1)], null, null);
    expect(r.gate.cleared).toBe(false);
    expect(r.blockedReason).toContain("has 1 across 1");
  });

  it("clears the gate with enough readings across enough cases", () => {
    const pts = Array.from({ length: 40 }, (_, i) => point(i));
    const r = liveAccuracyForLineage("l", pts, null, null);
    expect(r.gate.cleared).toBe(true);
    expect(r.cases).toBe(4);
  });

  it("counts only readings recorded after the last completed run", () => {
    const pts = [
      point(1, { recordedAt: "2026-01-01T00:00:00.000Z" }),
      point(2, { recordedAt: "2026-01-09T00:00:00.000Z" }),
    ];
    const r = liveAccuracyForLineage("l", pts, null, "2026-01-05T00:00:00.000Z");
    expect(r.readingsSinceRefit).toBe(1);
    expect(r.newestReadingAt).toBe("2026-01-09T00:00:00.000Z");
  });
});

describe("summariseLiveAccuracy", () => {
  it("groups by lineage and puts cleared lineages first", () => {
    const big = Array.from({ length: 40 }, (_, i) => point(i, { lineageKey: "big" }));
    const small = [point(1, { lineageKey: "small" })];
    const report = summariseLiveAccuracy([...small, ...big], new Map(), { lastRefitAt: null });
    expect(report.lineages.map((l) => l.lineageKey)).toEqual(["big", "small"]);
    expect(report.tickMinutes).toBe(15);
  });

  it("files readings with no recorded lineage under a named bucket", () => {
    const report = summariseLiveAccuracy([point(1, { lineageKey: null })], new Map(), {
      lastRefitAt: null,
    });
    expect(report.lineages[0]?.lineageKey).toBe("unrecorded");
  });
});
