import { describe, expect, it } from "vitest";

import { biasStatistic, clusterBootstrapCi, maeStatistic } from "./ci";
import { buildExchangeBundle, parseExchangeBundle, pseudonym } from "./exchange";
import { analyseOutcomeSignals, type OutcomeCase } from "./outcomes";
import { splitAtLock } from "./prospective.server";
import type { CoebisTrainingPoint } from "./coebis-covariates";

describe("clustered bootstrap intervals", () => {
  it("brackets the point estimate and respects case clustering", () => {
    const pairs = Array.from({ length: 40 }, (_, i) => ({
      caseKey: `case-${i % 8}`,
      predicted: 50 + (i % 5),
      bis: 48 + (i % 5),
    }));
    const ci = clusterBootstrapCi(pairs, maeStatistic);
    expect(ci).not.toBeNull();
    expect(ci!.lo).toBeLessThanOrEqual(ci!.hi);
    expect(maeStatistic(pairs)).toBeGreaterThan(0);
    expect(biasStatistic(pairs)).toBeCloseTo(2, 5);
  });

  it("returns null when there are too few cases to resample", () => {
    expect(clusterBootstrapCi([{ caseKey: "a", predicted: 50, bis: 50 }], maeStatistic)).toBeNull();
  });
});

describe("de-identified exchange bundles", () => {
  const rows = [
    {
      id: "row-1",
      session_id: "sess-1",
      at_seconds: 120,
      bis: 45,
      app_index: 52,
      app_sr: 0,
      bis_sef: 12,
      app_sef: 13,
      reliable: true,
      sqi: 0.9,
      context: "general_anaesthesia",
      recorded_at: "2026-08-01T10:00:00.000Z",
    },
  ];
  const cov = new Map([
    ["sess-1", { id: "sess-1", age_band: "70-79", sex: "female", regimen: "propofol", frailty: null }],
  ]);

  it("keeps the numbers but strips identifiers and exact times", () => {
    const bundle = buildExchangeBundle(rows, cov, "Theatre 4", "user-1");
    const point = bundle.points[0]!;
    expect(point.bis).toBe(45);
    expect(point.ageBand).toBe("70-79");
    expect(point.month).toBe("2026-08");
    expect(JSON.stringify(bundle)).not.toContain("sess-1");
  });

  it("round-trips through the parser and pseudonymises stably", () => {
    const bundle = buildExchangeBundle(rows, cov, "Theatre 4", "user-1");
    const parsed = parseExchangeBundle(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.ok).toBe(true);
    expect(parsed.bundle?.points).toHaveLength(1);
    expect(pseudonym("sess-1", "user-1")).toBe(pseudonym("sess-1", "user-1"));
    expect(pseudonym("sess-1", "user-1")).not.toBe(pseudonym("sess-1", "user-2"));
  });

  it("rejects a file that is not an exchange bundle", () => {
    expect(parseExchangeBundle({ hello: "world" }).ok).toBe(false);
  });
});

describe("prospective split", () => {
  const point = (recordedAt: string): CoebisTrainingPoint =>
    ({
      at: 0,
      bis: 50,
      appIndex: 55,
      sessionId: "s",
      reliable: true,
      sqi: 1,
      recordedAt,
      context: null,
      cov: { ageBand: null, sex: null, regimen: null, frailty: null },
    }) as CoebisTrainingPoint;

  it("counts only readings after the lock as unseen", () => {
    const split = splitAtLock(
      [point("2026-01-01T00:00:00Z"), point("2026-03-01T00:00:00Z")],
      "2026-02-01T00:00:00Z",
    );
    expect(split.before).toHaveLength(1);
    expect(split.after).toHaveLength(1);
  });
});

describe("outcome signals", () => {
  const base: OutcomeCase = {
    sessionId: "a",
    caseCode: "GA-1",
    ageBand: "70-79",
    durationMinutes: 100,
    meanDepth: 45,
    minutesDeep: 10,
    meanSr: 2,
    minutesSuppressed: 5,
    outcome: null,
  };

  it("flags thin arms as not yet meaningful", () => {
    const signals = analyseOutcomeSignals([
      {
        ...base,
        minutesSuppressed: 40,
        outcome: {
          sessionId: "a",
          delirium: "hypoactive",
          deliriumDays: 2,
          emergence: "smooth",
          awareness: false,
          unplannedIcu: false,
          mortality30d: false,
          lengthOfStayDays: null,
          notes: null,
        },
      },
      {
        ...base,
        sessionId: "b",
        outcome: {
          sessionId: "b",
          delirium: "none",
          deliriumDays: null,
          emergence: "smooth",
          awareness: false,
          unplannedIcu: false,
          mortality30d: false,
          lengthOfStayDays: null,
          notes: null,
        },
      },
    ]);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.meaningful)).toBe(false);
  });
});
