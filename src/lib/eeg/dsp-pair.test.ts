import { describe, it, expect } from "vitest";
import { computePsd, computePsdPair } from "./dsp";

function sig(n: number, f: number, phase = 0): Float64Array {
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = 20 * Math.sin((2 * Math.PI * f * i) / 256 + phase) + 3;
  return s;
}

describe("computePsdPair", () => {
  it("matches two separate periodograms", () => {
    const a = sig(512, 10);
    const b = sig(512, 22, 1.1);
    const [pa, pb] = computePsdPair(a, b);
    const ra = computePsd(a);
    const rb = computePsd(b);
    expect(pa.binWidth).toBe(ra.binWidth);
    for (let k = 0; k < ra.power.length; k++) {
      expect(pa.power[k]!).toBeCloseTo(ra.power[k]!, 6);
      expect(pb.power[k]!).toBeCloseTo(rb.power[k]!, 6);
      expect(pa.freqs[k]!).toBe(ra.freqs[k]!);
    }
  });

  it("is unaffected by scratch reuse across calls", () => {
    const a = sig(512, 10);
    const first = computePsd(a).power.slice();
    computePsd(sig(512, 30));
    computePsdPair(sig(512, 5), sig(512, 40));
    const again = computePsd(a).power;
    for (let k = 0; k < first.length; k++) expect(again[k]!).toBeCloseTo(first[k]!, 12);
  });
});
