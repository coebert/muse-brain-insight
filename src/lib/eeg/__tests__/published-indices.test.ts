import { describe, expect, it } from "vitest";

import {
  alphaDeltaFromBands,
  alphaDeltaOf,
  betaRatioOf,
  powerFromDbSpectrum,
  publishedIndices,
} from "../published-indices";
import { comparatorBenchmark, type LabelledEpoch } from "../pathology-labels";

/** Flat 0.5 Hz dB spectrum up to 50 Hz with an optional peak band. */
function spectrum(base: number, peak?: { lo: number; hi: number; db: number }): number[] {
  const out: number[] = [];
  for (let hz = 0.5; hz <= 50; hz += 0.5) {
    out.push(peak && hz >= peak.lo && hz <= peak.hi ? peak.db : base);
  }
  return out;
}

describe("powerFromDbSpectrum", () => {
  it("places the first bin at freqStart on a 0-based grid", () => {
    const grid = powerFromDbSpectrum([0, 0, 0, 0], 1, 0.5)!;
    expect(grid.binHz).toBe(0.5);
    expect(grid.power[0]).toBe(0);
    expect(grid.power[1]).toBe(0);
    expect(grid.power[2]).toBeCloseTo(1, 6);
  });

  it("rejects a spectrum too short to be usable", () => {
    expect(powerFromDbSpectrum([1, 2], 0.5, 0.5)).toBeNull();
  });
});

describe("published comparators", () => {
  it("beta ratio rises when fast power dominates", () => {
    const fast = powerFromDbSpectrum(spectrum(0, { lo: 30, hi: 47, db: 20 }), 0.5, 0.5)!;
    const slow = powerFromDbSpectrum(spectrum(0, { lo: 11, hi: 20, db: 20 }), 0.5, 0.5)!;
    expect(betaRatioOf(fast.power, 0.5)!).toBeGreaterThan(0);
    expect(betaRatioOf(slow.power, 0.5)!).toBeLessThan(0);
  });

  it("alpha/delta falls with delta-dominant slowing", () => {
    const slowed = powerFromDbSpectrum(spectrum(0, { lo: 0.5, hi: 4, db: 30 }), 0.5, 0.5)!;
    expect(alphaDeltaOf(slowed.power, 0.5)!).toBeLessThan(-10);
  });

  it("falls back to stored band powers when no spectrum was kept", () => {
    expect(alphaDeltaFromBands({ alpha: 10, delta: 1 })).toBeCloseTo(10, 3);
    expect(alphaDeltaFromBands({ alpha: 0, delta: 1 })).toBeNull();
    const out = publishedIndices(null, 0.5, 0.5, null, { alpha: 10, delta: 1 });
    expect(out.stateEntropy).toBeNull();
    expect(out.alphaDelta).toBeCloseTo(10, 3);
  });

  it("drives entropy towards zero as recorded suppression rises", () => {
    const flat = spectrum(0);
    const awake = publishedIndices(flat, 0.5, 0.5, 0);
    const suppressed = publishedIndices(flat, 0.5, 0.5, 90);
    expect(awake.stateEntropy!).toBeGreaterThan(suppressed.stateEntropy!);
    expect(awake.responseEntropy!).toBeGreaterThanOrEqual(awake.stateEntropy!);
  });
});

function epoch(
  caseRef: string,
  positive: boolean,
  scores: Partial<LabelledEpoch["scores"]>,
): LabelledEpoch {
  return {
    lineage: "test",
    caseRef,
    atSeconds: 0,
    labelSource: "dataset",
    seizure: null,
    cns: null,
    state: positive ? "anaesthetised" : "awake",
    scores: {
      coebis: null,
      seizureScore: null,
      suppressionRatio: null,
      sef95: null,
      ...scores,
    },
  };
}

describe("comparatorBenchmark", () => {
  const rows: LabelledEpoch[] = [];
  for (let i = 0; i < 60; i++) {
    const positive = i % 2 === 0;
    rows.push(
      epoch(`case-${i % 6}`, positive, {
        // COEBIS separates perfectly, the entropy comparator only partly.
        coebis: positive ? 40 + i * 0.1 : 80 + i * 0.1,
        stateEntropy: positive ? 50 + i : 55 + i,
        responseEntropy: positive ? 55 + i : 60 + i,
        betaRatio: positive ? -0.5 + i * 0.01 : -0.45,
        alphaDelta: positive ? -5 + i * 0.1 : -4.5,
        sef95: positive ? 10 + i * 0.2 : 12,
      }),
    );
  }

  it("grades COEBIS and comparators on the same epochs", () => {
    const bench = comparatorBenchmark(rows, (e) => e.state === "anaesthetised")!;
    expect(bench.n).toBe(60);
    expect(bench.coebisAuc).toBe(1);
    expect(bench.comparators).toHaveLength(5);
    expect(bench.bestComparatorAuc!).toBeLessThan(1);
    expect(bench.delta!).toBeGreaterThan(0);
    expect(bench.verdict).toContain("COEBIS ahead");
  });

  it("drops comparators that are missing from most labelled epochs", () => {
    const thin = rows.map((r) => ({ ...r, scores: { ...r.scores, betaRatio: null } }));
    const bench = comparatorBenchmark(thin, (e) => e.state === "anaesthetised")!;
    expect(bench.comparators.map((c) => c.score)).not.toContain("betaRatio");
  });

  it("returns null when COEBIS is absent", () => {
    const noCoebis = rows.map((r) => ({ ...r, scores: { ...r.scores, coebis: null } }));
    expect(comparatorBenchmark(noCoebis, (e) => e.state === "anaesthetised")).toBeNull();
  });
});
