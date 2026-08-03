import { describe, expect, it } from "vitest";
import {
  MUSE_SAMPLE_RATE,
  bandPower,
  computePsd,
  lineLength,
  makeEegFilter,
  peakToPeak,
  signalQuality,
  spectralEdge,
  spectralEntropy,
} from "./dsp";

/** Deterministic sine wave in µV. */
function sine(hz: number, amplitudeUv = 20, seconds = 4, fs = MUSE_SAMPLE_RATE) {
  const n = Math.round(seconds * fs);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitudeUv * Math.sin((2 * Math.PI * hz * i) / fs);
  return out;
}

describe("computePsd", () => {
  it("puts the peak at the tone frequency", () => {
    const psd = computePsd(sine(10));
    let peak = 0;
    for (let i = 1; i < psd.power.length; i++) if (psd.power[i]! > psd.power[peak]!) peak = i;
    expect(psd.freqs[peak]).toBeGreaterThan(9);
    expect(psd.freqs[peak]).toBeLessThan(11);
  });

  it("scales power with the square of amplitude", () => {
    const low = bandPower(computePsd(sine(10, 10)), 8, 13);
    const high = bandPower(computePsd(sine(10, 20)), 8, 13);
    expect(high / low).toBeGreaterThan(3.4);
    expect(high / low).toBeLessThan(4.6);
  });
});

describe("bandPower", () => {
  it("concentrates an alpha tone in the alpha band", () => {
    const psd = computePsd(sine(10));
    expect(bandPower(psd, 8, 13)).toBeGreaterThan(bandPower(psd, 13, 30) * 10);
  });
});

describe("spectralEdge", () => {
  it("sits just above a single low-frequency tone", () => {
    const sef = spectralEdge(computePsd(sine(6)), 0.95);
    expect(sef).toBeGreaterThan(5);
    expect(sef).toBeLessThan(9);
  });

  it("rises when fast activity dominates", () => {
    const slow = spectralEdge(computePsd(sine(4)), 0.95);
    const fast = spectralEdge(computePsd(sine(24)), 0.95);
    expect(fast).toBeGreaterThan(slow);
  });
});

describe("spectralEntropy", () => {
  it("is near zero for a pure tone and near one for white noise", () => {
    const tone = spectralEntropy(computePsd(sine(10)), 0.5, 32);
    let seed = 42;
    const noise = new Float64Array(1024);
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      noise[i] = (seed / 2147483648) * 40 - 20;
    }
    const flat = spectralEntropy(computePsd(noise), 0.5, 32);
    expect(tone).toBeLessThan(0.5);
    expect(flat).toBeGreaterThan(tone);
    expect(flat).toBeLessThanOrEqual(1);
  });
});

describe("peakToPeak and lineLength", () => {
  it("measures the amplitude of a known sine", () => {
    const p2p = peakToPeak(sine(10, 25), 0, MUSE_SAMPLE_RATE);
    expect(p2p).toBeGreaterThan(48);
    expect(p2p).toBeLessThan(52);
  });

  it("reports a flat trace as zero", () => {
    const flat = new Float64Array(256);
    expect(peakToPeak(flat, 0, 256)).toBe(0);
    expect(lineLength(flat)).toBe(0);
  });
});

describe("makeEegFilter", () => {
  it("attenuates DC drift", () => {
    const chain = makeEegFilter();
    const dc = new Float64Array(1024).fill(100);
    let last = 0;
    for (let i = 0; i < dc.length; i++) last = chain.process(dc[i]!);
    expect(Math.abs(last)).toBeLessThan(5);
  });
});

describe("signalQuality", () => {
  it("grades a clean alpha rhythm better than a clipped trace", () => {
    const clean = sine(10, 30);
    const clipped = new Float64Array(clean.length).fill(1800);
    const good = signalQuality(clean, computePsd(clean));
    const bad = signalQuality(clipped, computePsd(clipped));
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.score).toBeLessThan(0.6);
  });
});
