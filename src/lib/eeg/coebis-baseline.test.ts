import { describe, expect, it } from "vitest";

import { BASELINE_SAMPLES, coebisBaseline, coebisDriftSeries } from "./coebis-baseline";

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("coebisBaseline", () => {
  it("withholds a baseline until enough usable values exist", () => {
    const b = coebisBaseline(flat(BASELINE_SAMPLES - 1, 90));
    expect(b.value).toBeNull();
    expect(b.delta).toBeNull();
    expect(b.samples).toBe(BASELINE_SAMPLES - 1);
  });

  it("anchors on the first stable run and reports drift downward", () => {
    const b = coebisBaseline([...flat(BASELINE_SAMPLES, 92), ...flat(20, 45)]);
    expect(b.value).toBe(92);
    expect(b.latest).toBe(45);
    expect(b.delta).toBe(-47);
  });

  it("ignores gaps when collecting the baseline", () => {
    const b = coebisBaseline([null, ...flat(BASELINE_SAMPLES, 60), null, 50]);
    expect(b.value).toBe(60);
    expect(b.delta).toBe(-10);
  });

  it("keeps gaps as breaks in the drift series", () => {
    expect(coebisDriftSeries([50, null, 40], 45)).toEqual([5, null, -5]);
    expect(coebisDriftSeries([50], null)).toEqual([null]);
  });
});
