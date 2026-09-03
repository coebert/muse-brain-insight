import { describe, expect, it } from "vitest";

import {
  MIN_MAE_GAIN,
  dataFingerprint,
  planRefit,
  refitLineage,
  selectValidatedPoints,
  summariseRun,
} from "../coebis-refit";
import type { CoebisTrainingPoint } from "../coebis-covariates";

function point(over: Partial<CoebisTrainingPoint> & { bis: number; appIndex: number }): CoebisTrainingPoint {
  return {
    at: 0,
    recordedAt: "2026-01-01T00:00:00.000Z",
    sessionId: "case-1",
    reliable: true,
    sqi: 0.9,
    context: "anaesthesia",
    ce: null,
    lineageKey: "muse2:af7af8:256",
    cov: {
      ageBand: "60-74",
      sex: "male",
      regimen: "propofol_opioid",
      frailty: null,
      chronicBurden: null,
      chronicCns: null,
      acuteClass: null,
    },
    ...over,
  } as CoebisTrainingPoint;
}

describe("selectValidatedPoints", () => {
  it("keeps only readings that are safe to learn from", () => {
    const result = selectValidatedPoints([
      point({ bis: 45, appIndex: 50 }),
      point({ bis: 45, appIndex: 50, reliable: false }),
      point({ bis: 45, appIndex: 50, sqi: 0.1 }),
      point({ bis: 145, appIndex: 50 }),
      point({ bis: Number.NaN, appIndex: 50 }),
      point({ bis: 45, appIndex: 50, sessionId: null }),
    ]);
    expect(result.used).toHaveLength(1);
    expect(result.rejected).toMatchObject({
      unreliable: 1,
      low_sqi: 1,
      out_of_range: 1,
      not_finite: 1,
      no_case: 1,
    });
    expect(result.passRate).toBeCloseTo(1 / 6, 3);
  });
});

describe("dataFingerprint", () => {
  it("is order-independent and changes with the data", () => {
    const a = point({ bis: 40, appIndex: 48, at: 1 });
    const b = point({ bis: 44, appIndex: 50, at: 2 });
    expect(dataFingerprint([a, b])).toBe(dataFingerprint([b, a]));
    expect(dataFingerprint([a, b])).not.toBe(dataFingerprint([a]));
  });
});

describe("planRefit", () => {
  const points = [
    ...Array.from({ length: 5 }, (_, i) => point({ bis: 40 + i, appIndex: 48 + i, at: i })),
    ...Array.from({ length: 3 }, (_, i) =>
      point({ bis: 40 + i, appIndex: 48 + i, at: i, lineageKey: "focuscalm:af7:250" }),
    ),
  ];

  it("splits by lineage and never pools them", () => {
    const plan = planRefit(points, {});
    expect(plan.entries.map((e) => e.lineageKey).sort()).toEqual([
      "focuscalm:af7:250",
      "muse2:af7af8:256",
    ]);
    expect(plan.entries[0]!.points.every((p) => p.lineageKey === plan.entries[0]!.lineageKey)).toBe(true);
  });

  it("skips a lineage whose data is unchanged since its last version", () => {
    const digest = dataFingerprint(points.filter((p) => p.lineageKey === "muse2:af7af8:256"));
    const plan = planRefit(points, { "muse2:af7af8:256": digest });
    expect(plan.skippedUnchanged).toContain("muse2:af7af8:256");
    expect(plan.entries.map((e) => e.lineageKey)).toEqual(["focuscalm:af7:250"]);
  });

  it("bounds work per run and defers the rest", () => {
    const plan = planRefit(points, {}, 1);
    expect(plan.entries).toHaveLength(1);
    expect(plan.deferred).toHaveLength(1);
  });
});

describe("refitLineage", () => {
  const points: CoebisTrainingPoint[] = [];
  for (let c = 0; c < 6; c++) {
    for (let i = 0; i < 10; i++) {
      const bis = 30 + ((c * 7 + i * 3) % 50);
      points.push(point({ sessionId: `case-${c}`, at: i, bis, appIndex: bis + 12 }));
    }
  }

  it("refuses to fit a lineage without enough validated data", () => {
    const thin = refitLineage("muse2:af7af8:256", points.slice(0, 5), null);
    expect(thin.sufficient).toBe(false);
    expect(thin.promote).toBe(false);
    expect(thin.model).toBeNull();
  });

  it("promotes a candidate that clearly beats the raw index", () => {
    const result = refitLineage("muse2:af7af8:256", points, null);
    expect(result.sufficient).toBe(true);
    expect(result.beforeSource).toBe("raw_index");
    expect(result.after.mae!).toBeLessThan(result.before.mae!);
    expect(result.maeGain!).toBeGreaterThanOrEqual(MIN_MAE_GAIN);
    expect(result.promote).toBe(true);
    expect(result.model).not.toBeNull();
  });

  it("keeps the incumbent when the candidate adds nothing", () => {
    const first = refitLineage("muse2:af7af8:256", points, null);
    const second = refitLineage("muse2:af7af8:256", points, first.model);
    expect(second.beforeSource).toBe("incumbent");
    expect(second.promote).toBe(false);
    expect(second.reason).toMatch(/keeping the current model|agreement/);
  });
});

describe("summariseRun", () => {
  it("reports nothing to do plainly", () => {
    expect(summariseRun([])).toMatch(/No lineage/);
  });
});
