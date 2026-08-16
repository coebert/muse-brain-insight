import { describe, expect, it } from "vitest";

import { monitorEntropy, entropyWindowSeconds, SE_MAX } from "./entropy-monitor";
import { montageFeatures } from "./psi-features";
import { coebisAdjunct, ADJUNCT_CAP } from "./coebis-adjuncts";

const BIN = 0.5;
const NBINS = Math.round(47 / BIN) + 1;

/** PSD row with power concentrated in [lo, hi] Hz. */
function row(lo: number, hi: number, extra?: { lo: number; hi: number; gain: number }) {
  const r = new Float64Array(NBINS);
  for (let k = 0; k < NBINS; k++) {
    const hz = k * BIN;
    r[k] = hz >= lo && hz <= hi ? 1 : 1e-6;
    if (extra && hz >= extra.lo && hz <= extra.hi) r[k] = extra.gain;
  }
  return r;
}

describe("entropy windows", () => {
  it("uses long windows for slow rhythms and short ones for the EMG band", () => {
    expect(entropyWindowSeconds(1)).toBeGreaterThan(entropyWindowSeconds(10));
    expect(entropyWindowSeconds(40)).toBeLessThanOrEqual(2);
  });
});

describe("monitorEntropy", () => {
  it("returns nulls without any usable spectrum", () => {
    expect(monitorEntropy([null, null], 0).se).toBeNull();
  });

  it("is higher for a broad spectrum than a narrow one", () => {
    const broad = monitorEntropy(Array.from({ length: 30 }, () => row(0.5, 32)), 0);
    const narrow = monitorEntropy(Array.from({ length: 30 }, () => row(1, 4)), 0);
    expect(broad.se!).toBeGreaterThan(narrow.se!);
    expect(broad.se!).toBeLessThanOrEqual(SE_MAX);
  });

  it("falls towards zero as the suppression ratio rises", () => {
    const rows = Array.from({ length: 30 }, () => row(0.5, 32));
    const light = monitorEntropy(rows, 0).se!;
    const deep = monitorEntropy(rows, 80).se!;
    expect(deep).toBeLessThan(light * 0.3);
  });

  it("reports RE equal to SE when there is no EMG band power", () => {
    const e = monitorEntropy(Array.from({ length: 30 }, () => row(0.5, 30)), 0);
    expect(e.re! - e.se!).toBeLessThan(0.5);
    expect(e.emgGap!).toBeLessThan(0.5);
  });

  it("opens an RE-SE gap when 32-47 Hz power appears", () => {
    const rows = Array.from({ length: 30 }, () =>
      row(0.5, 30, { lo: 32, hi: 47, gain: 1.5 }),
    );
    const e = monitorEntropy(rows, 0);
    expect(e.emgGap!).toBeGreaterThan(1);
    expect(e.re!).toBeGreaterThanOrEqual(e.se!);
  });
});

describe("montageFeatures", () => {
  const spectrum = (alphaDb: number) =>
    Array.from({ length: 60 }, (_, i) => {
      const hz = 0.5 + (i * (30 - 0.5)) / 59;
      if (hz >= 8 && hz <= 12) return alphaDb;
      if (hz <= 4) return 5;
      return -10;
    });

  it("detects alpha and slow-wave dominance", () => {
    const f = montageFeatures(spectrum(10), spectrum(10));
    expect(f.alphaFraction!).toBeGreaterThan(0.1);
    expect(f.slowFraction!).toBeGreaterThan(0.1);
  });

  it("is symmetric and coherent for identical hemispheres", () => {
    const f = montageFeatures(spectrum(6), spectrum(6));
    expect(f.coherence!).toBeGreaterThan(0.99);
    expect(f.asymmetry!).toBeLessThan(0.01);
  });

  it("returns null bilateral features when a side is missing", () => {
    const f = montageFeatures(spectrum(6), null);
    expect(f.coherence).toBeNull();
    expect(f.asymmetry).toBeNull();
  });
});

describe("coebisAdjunct", () => {
  const entropy = (se: number, re: number) => ({ se, re, emgGap: re - se, bsr: 0 });

  it("does nothing without supporting features", () => {
    const a = coebisAdjunct({ aligned: 45, entropy: null, montage: null, bsr: 0 });
    expect(a.total).toBe(0);
    expect(a.parts).toHaveLength(0);
  });

  it("credits frontal EMG upwards, as a commercial BIS would read", () => {
    const a = coebisAdjunct({
      aligned: 45,
      entropy: entropy(45, 70),
      montage: null,
      bsr: 0,
    });
    expect(a.total).toBeGreaterThan(0);
    expect(a.parts.some((p) => p.label.includes("EMG"))).toBe(true);
  });

  it("pulls the index down towards the suppression ceiling", () => {
    const a = coebisAdjunct({ aligned: 55, entropy: null, montage: null, bsr: 60 });
    expect(a.total).toBeLessThan(0);
  });

  it("never exceeds the cap", () => {
    const a = coebisAdjunct({
      aligned: 90,
      entropy: entropy(10, 90),
      montage: null,
      bsr: 0,
    });
    expect(Math.abs(a.total)).toBeLessThanOrEqual(ADJUNCT_CAP);
  });

  it("shrinks the correction when the hemispheres disagree", () => {
    const shared = { aligned: 45, entropy: entropy(45, 70), bsr: 0 };
    const clean = coebisAdjunct({
      ...shared,
      montage: { coherence: 0.95, asymmetry: 0.05, alphaFraction: null, slowFraction: null },
    });
    const messy = coebisAdjunct({
      ...shared,
      montage: { coherence: 0.1, asymmetry: 0.6, alphaFraction: null, slowFraction: null },
    });
    expect(Math.abs(messy.total)).toBeLessThan(Math.abs(clean.total));
  });

  it("recognises the anaesthetic alpha/slow-wave pattern as deeper than reported", () => {
    const a = coebisAdjunct({
      aligned: 70,
      entropy: null,
      montage: { coherence: 0.9, asymmetry: 0.05, alphaFraction: 0.25, slowFraction: 0.5 },
      bsr: 0,
    });
    expect(a.total).toBeLessThan(0);
  });
});
