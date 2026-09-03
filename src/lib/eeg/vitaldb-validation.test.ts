import { describe, expect, it } from "vitest";

import {
  assessGateCoverage,
  MIN_POINTS_PER_CASE,
  validatePairedCase,
  validatePairedCases,
} from "./vitaldb-validation";
import type { VitalDbPairedCase, VitalDbPairedPoint } from "./vitaldb-waveform";

function point(over: Partial<VitalDbPairedPoint> = {}): VitalDbPairedPoint {
  return {
    atSeconds: 0,
    bis: 50,
    bisSef: 12,
    bisSr: 0,
    sqi: 90,
    appIndex: 48,
    appSef: 11,
    appSr: 0,
    reliable: true,
    lagSeconds: 0.4,
    ce: {},
    externalRef: "ref",
    ...over,
  };
}

function pairedCase(points: VitalDbPairedPoint[], caseRef = "vitaldb-1"): VitalDbPairedCase {
  return {
    caseRef,
    lineageKey: "vitaldb-snuadc|AF7-AF8|128",
    lineage: {} as never,
    covariates: {} as never,
    channels: ["AF7", "AF8"],
    sampleRate: 128,
    durationSeconds: 1200,
    points,
    rejected: { noBis: 0, badRange: 0, lowSqi: 0, unmatched: 0, noIndex: 0 },
  };
}

/** A well-spread case: 20 pairs over 20 minutes with a real BIS swing. */
function goodCase(caseRef: string): VitalDbPairedCase {
  return pairedCase(
    Array.from({ length: 20 }, (_, i) =>
      point({ atSeconds: i * 60, bis: 30 + i * 2, appIndex: 35 + i * 2 }),
    ),
    caseRef,
  );
}

describe("validatePairedCase", () => {
  it("accepts a case with spread, range and real pairs", () => {
    const v = validatePairedCase(goodCase("vitaldb-1"));
    expect(v.verdict).toBe("usable");
    expect(v.validPoints).toBe(20);
    expect(v.spanSeconds).toBe(1140);
    expect(v.bisRange).toEqual({ min: 30, max: 68 });
  });

  it("rejects too few pairs", () => {
    const v = validatePairedCase(
      pairedCase(
        Array.from({ length: MIN_POINTS_PER_CASE - 1 }, (_, i) => point({ atSeconds: i * 200 })),
      ),
    );
    expect(v.verdict).toBe("rejected");
    expect(v.reasons.join(" ")).toMatch(/paired reading/);
  });

  it("rejects pairs crammed into one moment", () => {
    const v = validatePairedCase(
      pairedCase(Array.from({ length: 10 }, (_, i) => point({ atSeconds: i, bis: 30 + i * 3 }))),
    );
    expect(v.verdict).toBe("rejected");
    expect(v.reasons.join(" ")).toMatch(/case time/);
  });

  it("drops non-simultaneous, out-of-range, duplicate and non-finite samples", () => {
    const base = goodCase("vitaldb-2").points;
    const v = validatePairedCase(
      pairedCase([
        ...base,
        point({ atSeconds: 5000, lagSeconds: 9 }),
        point({ atSeconds: 5100, bis: 140 }),
        point({ atSeconds: 5200, appIndex: Number.NaN }),
        point({ atSeconds: 0 }),
      ]),
    );
    expect(v.dropped.lagTooLarge).toBe(1);
    expect(v.dropped.bisOutOfRange).toBe(1);
    expect(v.dropped.nonFinite).toBe(1);
    expect(v.dropped.duplicate).toBe(1);
    expect(v.validPoints).toBe(20);
  });

  it("flags a case the monitor itself did not trust", () => {
    const v = validatePairedCase(
      pairedCase(
        Array.from({ length: 20 }, (_, i) =>
          point({ atSeconds: i * 60, bis: 30 + i * 2, reliable: i % 4 === 0 }),
        ),
      ),
    );
    expect(v.verdict).toBe("flagged");
    expect(v.reasons.join(" ")).toMatch(/signal quality/);
  });
});

describe("validatePairedCases", () => {
  it("keeps usable and flagged cases but excludes rejected ones", () => {
    const result = validatePairedCases([
      goodCase("vitaldb-1"),
      pairedCase([point()], "vitaldb-2"),
    ]);
    expect(result.acceptedCaseRefs).toEqual(["vitaldb-1"]);
    expect(result.rejectedCases).toBe(1);
    expect(result.validPoints).toBe(20);
    expect(result.ok).toBe(true);
  });

  it("reports failure when nothing paired", () => {
    const result = validatePairedCases([pairedCase([], "vitaldb-3")]);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/usable EEG-index-to-BIS pairs/);
  });
});

describe("assessGateCoverage", () => {
  it("reports the shortfall for a lineage below the gate", () => {
    const cov = assessGateCoverage(
      [{ lineageKey: "L1", readings: 18, cases: 2 }],
      ["L1"],
    );
    expect(cov.ready).toBe(false);
    expect(cov.lineages[0]!.shortfall).toMatch(/18\/30 readings across 2\/3 cases/);
    expect(cov.lineages[0]!.shortfall).toMatch(/12 more readings and 1 more case/);
  });

  it("clears the gate only on lineages with enough readings and cases", () => {
    const cov = assessGateCoverage(
      [
        { lineageKey: "L1", readings: 40, cases: 4 },
        { lineageKey: "L2", readings: 400, cases: 1 },
      ],
      ["L1", "L2"],
    );
    expect(cov.ready).toBe(true);
    expect(cov.lineages.find((l) => l.lineageKey === "L2")!.meetsGate).toBe(false);
  });

  it("treats an unseen lineage as empty rather than assuming coverage", () => {
    const cov = assessGateCoverage([], ["L9"]);
    expect(cov.lineages[0]!.readings).toBe(0);
    expect(cov.ready).toBe(false);
  });
});
