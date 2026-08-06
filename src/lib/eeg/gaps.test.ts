import { describe, expect, it } from "vitest";

import {
  alignSeries,
  detectGaps,
  isInGap,
  nullRuns,
  spansGap,
  totalGapSeconds,
  withGapRows,
} from "./gaps";

describe("detectGaps", () => {
  it("ignores normal one-second cadence", () => {
    expect(detectGaps([0, 1, 2, 3])).toEqual([]);
  });

  it("reports a dropout between epochs", () => {
    const gaps = detectGaps([0, 1, 2, 40, 41]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ startT: 2, endT: 40, seconds: 38 });
    expect(totalGapSeconds(gaps)).toBe(38);
    expect(isInGap(gaps, 20)).toBe(true);
    expect(isInGap(gaps, 41)).toBe(false);
  });

  it("treats mild jitter as continuous", () => {
    expect(spansGap(0, 2)).toBe(false);
    expect(spansGap(0, 5)).toBe(true);
  });
});

describe("alignSeries", () => {
  it("leaves nulls where epochs are missing", () => {
    const epochs = [
      { t: 0, v: 10 },
      { t: 1, v: 11 },
      { t: 4, v: 14 },
    ];
    const out = alignSeries(
      epochs,
      (e) => e.t,
      (e) => e.v,
    );
    expect(out).toEqual([10, 11, null, null, 14]);
    expect(nullRuns(out)).toEqual([[2, 3]]);
  });
});

describe("withGapRows", () => {
  it("inserts blank rows around a gap so charts break the line", () => {
    const rows = [
      { t: 0, v: 1 },
      { t: 30, v: 2 },
    ];
    const out = withGapRows(rows, (t) => ({ t, v: null as number | null }));
    expect(out.map((r) => r.v)).toEqual([1, null, null, 2]);
  });
});
