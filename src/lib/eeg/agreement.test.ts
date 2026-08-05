import { describe, expect, it } from "vitest";

import {
  agreementMetrics,
  agreementVerdict,
  alignSeries,
  bestLagSeconds,
  buildPairedCsv,
  guessColumns,
  medianInterval,
  parseDelimited,
  parseTime,
  readSeries,
  type Point,
} from "@/lib/eeg/agreement";

describe("parseDelimited", () => {
  it("reads a headed CSV", () => {
    const t = parseDelimited("time,bis\n0,90\n1,88\n");
    expect(t.headers).toEqual(["time", "bis"]);
    expect(t.rows).toHaveLength(2);
  });

  it("detects tab and semicolon files", () => {
    expect(parseDelimited("time\tbis\n0\t90").delimiter).toBe("\t");
    expect(parseDelimited("time;bis\n0;90").delimiter).toBe(";");
  });

  it("synthesises headers when the first row is already data", () => {
    const t = parseDelimited("0,90\n1,88");
    expect(t.headers).toEqual(["column 1", "column 2"]);
    expect(t.rows).toHaveLength(2);
  });

  it("honours quoted commas and skips comment lines", () => {
    const t = parseDelimited('# exported\ntime,label\n0,"deep, stable"\n');
    expect(t.rows[0]).toEqual(["0", "deep, stable"]);
  });
});

describe("parseTime", () => {
  it("accepts seconds, mm:ss and hh:mm:ss", () => {
    expect(parseTime("12.5")).toBe(12.5);
    expect(parseTime("01:30")).toBe(90);
    expect(parseTime("01:00:30")).toBe(3630);
  });

  it("rejects free text", () => {
    expect(parseTime("not a time")).toBeNull();
    expect(parseTime("")).toBeNull();
  });
});

describe("guessColumns", () => {
  it("picks time and reference index columns from the headers", () => {
    const g = guessColumns(parseDelimited("elapsed,BIS,note_col\n0,90,x\n1,88,y"));
    expect(g.timeColumn).toBe(0);
    expect(g.indexColumn).toBe(1);
  });

  it("recognises a raw EEG column", () => {
    const g = guessColumns(parseDelimited("time,AF7_uV\n0,12.3\n1,-4.5"));
    expect(g.eegColumn).toBe(1);
  });
});

describe("readSeries", () => {
  it("rebases time on the first sample", () => {
    const table = parseDelimited("time,bis\n100,90\n101,88");
    const s = readSeries(table, 0, 1);
    expect(s.map((p) => p.t)).toEqual([0, 1]);
  });

  it("falls back to a fixed rate when there is no time column", () => {
    const s = readSeries(parseDelimited("bis\n90\n88\n86"), null, 0, 2);
    expect(s.map((p) => p.t)).toEqual([0, 0.5, 1]);
  });

  it("skips unparseable rows", () => {
    const s = readSeries(parseDelimited("time,bis\n0,90\n1,\n2,abc\n3,80"), 0, 1);
    expect(s).toHaveLength(2);
  });
});

const series = (values: number[], step = 1): Point[] =>
  values.map((v, i) => ({ t: i * step, v }));

describe("alignSeries", () => {
  it("pairs samples inside the tolerance", () => {
    const pairs = alignSeries(series([1, 2, 3]), series([1, 2, 3]), 0.5);
    expect(pairs).toHaveLength(3);
  });

  it("drops samples outside the tolerance", () => {
    const shifted = series([1, 2, 3]).map((p) => ({ ...p, t: p.t + 10 }));
    expect(alignSeries(series([1, 2, 3]), shifted, 0.5)).toHaveLength(0);
  });

  it("applies a lag before matching", () => {
    const test = series([1, 2, 3]).map((p) => ({ ...p, t: p.t + 5 }));
    expect(alignSeries(series([1, 2, 3]), test, 0.5, -5)).toHaveLength(3);
  });
});

describe("agreementMetrics", () => {
  it("reports perfect agreement for identical series", () => {
    const pairs = alignSeries(series([40, 45, 50, 55, 60]), series([40, 45, 50, 55, 60]), 0.5);
    const m = agreementMetrics(pairs);
    expect(m.r).toBeCloseTo(1, 6);
    expect(m.ccc).toBeCloseTo(1, 6);
    expect(m.bias).toBeCloseTo(0, 6);
    expect(m.rmse).toBeCloseTo(0, 6);
    expect(m.within5).toBe(100);
    expect(m.slope).toBeCloseTo(1, 6);
  });

  it("recovers a constant offset as bias with r still 1", () => {
    const m = agreementMetrics(
      alignSeries(series([40, 45, 50, 55, 60]), series([45, 50, 55, 60, 65]), 0.5),
    );
    expect(m.bias).toBeCloseTo(5, 6);
    expect(m.r).toBeCloseTo(1, 6);
    expect(m.ccc!).toBeLessThan(1);
    expect(m.loaUpper - m.loaLower).toBeCloseTo(0, 6);
  });

  it("returns empty metrics below three pairs", () => {
    const m = agreementMetrics([{ t: 0, reference: 50, test: 50 }]);
    expect(m.r).toBeNull();
    expect(m.n).toBe(1);
  });
});

describe("bestLagSeconds", () => {
  it("finds a known delay between two traces", () => {
    const values = [90, 85, 70, 55, 45, 40, 42, 50, 65, 80, 88];
    const reference = series(values);
    const delayed = values.map((v, i) => ({ t: i + 3, v }));
    const { lag } = bestLagSeconds(reference, delayed, 0.5, 10, 1);
    expect(lag).toBe(-3);
  });
});

describe("reporting", () => {
  it("grades close agreement as excellent and poor agreement as poor", () => {
    const good = agreementMetrics(
      alignSeries(series([40, 45, 50, 55, 60, 65]), series([41, 46, 49, 56, 60, 66]), 0.5),
    );
    expect(agreementVerdict(good)).toMatch(/Excellent|Good/);
    const bad = agreementMetrics(
      alignSeries(series([40, 45, 50, 55, 60, 65]), series([90, 20, 70, 10, 80, 30]), 0.5),
    );
    expect(agreementVerdict(bad)).toMatch(/Poor/);
  });

  it("writes a paired CSV with a difference column", () => {
    const csv = buildPairedCsv([{ t: 0, reference: 50, test: 55 }]);
    expect(csv.split("\n")[0]).toBe("t_seconds,reference,test,difference");
    expect(csv).toContain("5.000");
  });

  it("measures the median sampling interval", () => {
    expect(medianInterval(series([1, 2, 3, 4], 5))).toBe(5);
  });
});
