import { describe, expect, it } from "vitest";

import { featuresFromStoredSpectrum, psdFromStoredSpectrum, scoreStoredCase } from "./coebis-spectra";

/** A 0.5 Hz grid from 0.5 Hz, tilted towards slow or fast power. */
function spectrum(slow: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < 90; i++) {
    const f = 0.5 + i * 0.5;
    out.push(slow ? 20 - f * 0.4 : 5 + f * 0.05);
  }
  return out;
}

describe("COEBIS on a stored spectrum", () => {
  it("rebuilds a usable spectrum grid", () => {
    const psd = psdFromStoredSpectrum(spectrum(true), 0.5, 0.5);
    expect(psd).not.toBeNull();
    expect(psd!.binWidth).toBe(0.5);
    expect(psd!.freqs[2]).toBeCloseTo(1, 6);
  });

  it("refuses a spectrum it cannot read", () => {
    expect(psdFromStoredSpectrum(null, 0.5, 0.5)).toBeNull();
    expect(psdFromStoredSpectrum([1, 2], 0.5, 0.5)).toBeNull();
  });

  it("supplies the amplitude terms the fit expects", () => {
    const built = featuresFromStoredSpectrum({
      atSeconds: 0,
      spectrumDb: spectrum(true),
      freqStart: 0.5,
      freqStep: 0.5,
      suppressionPct: 25,
    });
    expect(built).not.toBeNull();
    expect(built!.suppressionFraction).toBeCloseTo(0.25, 6);
    expect(Number.isFinite(built!.features["logRms"]!)).toBe(true);
    expect(built!.features["logPtp"]!).toBeGreaterThan(built!.features["logRms"]!);
  });

  it("scores a case in order and stays on the index scale", () => {
    const epochs = Array.from({ length: 20 }, (_, i) => ({
      atSeconds: i * 4,
      spectrumDb: spectrum(i > 9),
      freqStart: 0.5,
      freqStep: 0.5,
      suppressionPct: 0,
    }));
    const readings = scoreStoredCase(epochs);
    expect(readings).toHaveLength(20);
    expect(readings[0]!.atSeconds).toBe(0);
    for (const r of readings) {
      expect(r.index).toBeGreaterThanOrEqual(0);
      expect(r.index).toBeLessThanOrEqual(100);
    }
  });
});
