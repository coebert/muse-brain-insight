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

  it("refuses to fabricate peak-to-peak or suppression from a spectrum alone", () => {
    const built = featuresFromStoredSpectrum({
      atSeconds: 0,
      spectrumDb: spectrum(true),
      freqStart: 0.5,
      freqStep: 0.5,
      suppressionPct: 25,
    });
    expect(built.available).toBe(false);
    if (built.available) return;
    expect(built.missing).toContain("measured-peak-to-peak");
    // A collection's own suppression ratio is a different detector: not substituted.
    expect(built.missing).toContain("measured-5uv-suppression");
    expect(built.missing).toContain("calibrated-amplitude");
    expect(built.reason).toMatch(/unavailable/i);
  });

  it("never reads a missing suppression value as zero suppression", () => {
    const built = featuresFromStoredSpectrum({
      atSeconds: 0,
      spectrumDb: spectrum(true),
      freqStart: 0.5,
      freqStep: 0.5,
      suppressionPct: null,
      peakToPeakUv: 40,
      amplitudeCalibrated: true,
    });
    expect(built.available).toBe(false);
    if (built.available) return;
    expect(built.missing).toEqual(["measured-5uv-suppression"]);
  });

  it("scores only when every required input was genuinely measured", () => {
    const built = featuresFromStoredSpectrum({
      atSeconds: 0,
      spectrumDb: spectrum(true),
      freqStart: 0.5,
      freqStep: 0.5,
      suppressionPct: null,
      peakToPeakUv: 40,
      suppressionFraction5uv: 0.25,
      amplitudeCalibrated: true,
    });
    expect(built.available).toBe(true);
    if (!built.available) return;
    expect(built.suppressionFraction).toBeCloseTo(0.25, 6);
    expect(built.features["logPtp"]).toBeCloseTo(Math.log10(40), 6);
    expect(built.derived.join(" ")).toMatch(/Parseval/);
  });

  it("returns an explicit unavailable result for a spectrum-only case", () => {
    const epochs = Array.from({ length: 20 }, (_, i) => ({
      atSeconds: i * 4,
      spectrumDb: spectrum(i > 9),
      freqStart: 0.5,
      freqStep: 0.5,
      suppressionPct: 0,
    }));
    const score = scoreStoredCase(epochs);
    expect(score.readings).toHaveLength(0);
    expect(score.unavailable).toBe(20);
    expect(score.reason).toMatch(/peak-to-peak/);
  });

  it("scores a fully measured case in order and stays on the index scale", () => {
    const epochs = Array.from({ length: 20 }, (_, i) => ({
      atSeconds: i * 4,
      spectrumDb: spectrum(i > 9),
      freqStart: 0.5,
      freqStep: 0.5,
      suppressionPct: null,
      peakToPeakUv: 60,
      suppressionFraction5uv: 0,
      amplitudeCalibrated: true,
    }));
    const score = scoreStoredCase(epochs);
    expect(score.readings).toHaveLength(20);
    expect(score.unavailable).toBe(0);
    expect(score.reason).toBeNull();
    expect(score.readings[0]!.atSeconds).toBe(0);
    for (const r of score.readings) {
      expect(r.index).toBeGreaterThanOrEqual(0);
      expect(r.index).toBeLessThanOrEqual(100);
    }
  });
});
