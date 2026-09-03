import { describe, expect, it } from "vitest";

import {
  buildLineageComparisons,
  thinSeries,
  MAX_SERIES_POINTS,
  type LineageModel,
} from "../lineage-comparison";
import type { CoebisModel, CoebisTrainingPoint } from "../coebis-covariates";

const model = (offset: number): CoebisModel => ({
  family: "covariate",
  gain: 1,
  offset,
  knots: [],
  terms: [],
  ceTerms: [],
  diagnostics: null,
  caseIntercepts: {},
  n: 100,
  sessions: 4,
});

function point(
  i: number,
  lineage: string | null,
  bis: number,
  appIndex: number,
  session = "s1",
): CoebisTrainingPoint {
  return {
    at: i,
    bis,
    appIndex,
    appSr: 0,
    sessionId: session,
    reliable: true,
    sqi: 0.9,
    depthConfidence: 0.9,
    recordedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    context: null,
    ce: null,
    lineageKey: lineage,
    cov: {
      ageBand: null,
      sex: null,
      regimen: null,
      frailty: null,
      chronicBurden: null,
      chronicCns: null,
      acuteClass: null,
    },
  } as CoebisTrainingPoint;
}

describe("lineage comparison", () => {
  it("keeps lineages separate and never pools them", () => {
    const points = [
      ...Array.from({ length: 15 }, (_, i) => point(i, "muse:af7af8:256", 45, 52, `a${i % 3}`)),
      ...Array.from({ length: 15 }, (_, i) => point(100 + i, "bridge:af7:250", 45, 40, `b${i % 3}`)),
    ];
    const models = new Map<string, LineageModel>([
      ["muse:af7af8:256", { model: model(-7), version: 3 }],
      ["bridge:af7:250", { model: model(5), version: 1 }],
    ]);
    const out = buildLineageComparisons(points, models);
    expect(out).toHaveLength(2);
    const muse = out.find((l) => l.lineageKey === "muse:af7af8:256")!;
    expect(muse.points).toBe(15);
    expect(muse.cases).toBe(3);
    expect(muse.coebis?.bias).toBeCloseTo(0, 5);
    expect(muse.raw.bias).toBeCloseTo(7, 5);
    expect(muse.maeGain).toBeGreaterThan(0);
    expect(muse.sufficient).toBe(true);
  });

  it("flags a lineage with no fitted model instead of scoring it", () => {
    const points = Array.from({ length: 20 }, (_, i) => point(i, "unknown:dev", 50, 60, `c${i % 4}`));
    const out = buildLineageComparisons(points, new Map());
    expect(out[0]!.hasModel).toBe(false);
    expect(out[0]!.coebis).toBeNull();
    expect(out[0]!.sufficient).toBe(false);
    expect(out[0]!.verdict).toContain("No promoted COEBIS model");
  });

  it("marks thin lineages insufficient but still shows them", () => {
    const points = Array.from({ length: 4 }, (_, i) => point(i, "muse:af7af8:256", 50, 50));
    const out = buildLineageComparisons(
      points,
      new Map([["muse:af7af8:256", { model: model(0), version: 1 }]]),
    );
    expect(out[0]!.sufficient).toBe(false);
    expect(out[0]!.points).toBe(4);
  });

  it("groups readings without a lineage under unattributed and sorts them last", () => {
    const points = [
      ...Array.from({ length: 5 }, (_, i) => point(i, null, 50, 50)),
      ...Array.from({ length: 6 }, (_, i) => point(50 + i, "muse:af7af8:256", 50, 50, `d${i}`)),
    ];
    const out = buildLineageComparisons(points, new Map());
    expect(out.map((l) => l.lineageKey)).toEqual(["muse:af7af8:256", "unattributed"]);
  });

  it("thins long series while keeping the endpoints", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const thinned = thinSeries(items);
    expect(thinned).toHaveLength(MAX_SERIES_POINTS);
    expect(thinned[0]).toBe(0);
    expect(thinned[thinned.length - 1]).toBe(999);
  });
});
