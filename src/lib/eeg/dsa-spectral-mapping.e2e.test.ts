/**
 * End-to-end: FFT windowing and frequency-bin mapping behind the spectral
 * array tile, for Muse 2 playback.
 *
 * Pushes synthetic Muse 2 recordings with known tones through the real
 * analyzer and checks that
 *   - the Hann taper and PSD normalisation recover the true tone power,
 *   - `Epoch.spectrum` index i maps to the frequency the DSA axis assumes,
 *   - the painted peak lands on the ingested frequency across the band,
 *   - the paired-FFT path used for bilateral lanes agrees exactly, and
 *   - baseline drift is detrended instead of leaking into delta.
 */
import { describe, expect, it } from "vitest";

import { DSA_MAX_HZ, DSA_MIN_HZ, EegAnalyzer, type Epoch } from "@/lib/eeg/analysis";
import { MUSE_SAMPLE_RATE, bandPower, computePsd, computePsdPair } from "@/lib/eeg/dsp";

const FS = MUSE_SAMPLE_RATE; // 256 Hz
const EPOCH_SAMPLES = FS * 4; // 4 s analysis window
/** Largest power of two inside a 4 s window; sets the bin spacing. */
const NFFT = 1024;
const BIN_HZ = FS / NFFT; // 0.25 Hz

/** Index of the first PSD bin the DSA keeps (first f >= DSA_MIN_HZ). */
const FIRST_BIN = Math.ceil(DSA_MIN_HZ / BIN_HZ);
/** Frequency (Hz) of spectrum column `i` as the DSA axis assumes it. */
const hzForColumn = (i: number) => (FIRST_BIN + i) * BIN_HZ;

function tone(seconds: number, hz: number, amplitude = 30, seed = 7): Float64Array {
  const out = new Float64Array(Math.round(seconds * FS));
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < out.length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / FS) + 0.5 * rand();
  }
  return out;
}

function ingestToEpochs(signal: Float64Array): Epoch[] {
  const analyzer = new EegAnalyzer(undefined, FS);
  const epochs: Epoch[] = [];
  for (let start = 0; start + EPOCH_SAMPLES <= signal.length; start += FS) {
    epochs.push(
      analyzer.analyze(
        Float64Array.from(signal.subarray(start, start + EPOCH_SAMPLES)),
        (start + EPOCH_SAMPLES) / FS,
      ),
    );
  }
  return epochs;
}

const argMax = (xs: number[]) => xs.reduce((best, v, i) => (v > xs[best]! ? i : best), 0);

describe("spectral array windowing and bin mapping (Muse 2 playback)", () => {
  it("uses a 1024-point transform with 0.25 Hz bins at the Muse sample rate", () => {
    const psd = computePsd(tone(4, 10), FS);
    expect(psd.binWidth).toBeCloseTo(BIN_HZ, 12);
    expect(psd.freqs.length).toBe(NFFT / 2);
    expect(psd.freqs[0]).toBe(0);
    expect(psd.freqs[1]).toBeCloseTo(BIN_HZ, 12);
    expect(psd.freqs[psd.freqs.length - 1]).toBeCloseTo(FS / 2 - BIN_HZ, 9);
  });

  it("recovers the true tone power through the Hann taper (A²/2)", () => {
    const amplitude = 30;
    const psd = computePsd(tone(4, 10, amplitude), FS);
    const around = bandPower(psd, 9, 11);
    expect(around).toBeGreaterThan(0.9 * (amplitude * amplitude) / 2);
    expect(around).toBeLessThan(1.1 * (amplitude * amplitude) / 2);
    // Hann sidelobes must not smear the tone across the rest of the band.
    expect(bandPower(psd, DSA_MIN_HZ, 8)).toBeLessThan(0.02 * around);
    expect(bandPower(psd, 12, DSA_MAX_HZ)).toBeLessThan(0.02 * around);
  });

  it("maps spectrum columns onto the frequency axis the DSA draws", () => {
    const epoch = ingestToEpochs(tone(6, 10)).at(-1)!;
    const psd = computePsd(tone(4, 10), FS);
    const kept = [...psd.freqs].filter((f) => f >= DSA_MIN_HZ && f <= DSA_MAX_HZ);
    expect(epoch.spectrum.length).toBe(kept.length);
    expect(hzForColumn(0)).toBeCloseTo(kept[0]!, 12);
    expect(hzForColumn(epoch.spectrum.length - 1)).toBeCloseTo(kept.at(-1)!, 12);
    expect(hzForColumn(epoch.spectrum.length - 1)).toBeLessThanOrEqual(DSA_MAX_HZ);
  });

  it("puts the painted peak on the ingested frequency across the band", () => {
    for (const hz of [2, 4, 6, 10, 14, 20, 26]) {
      const epoch = ingestToEpochs(tone(6, hz)).at(-1)!;
      const peakHz = hzForColumn(argMax(epoch.spectrum));
      expect(Math.abs(peakHz - hz), `peak for ${hz} Hz was ${peakHz} Hz`).toBeLessThanOrEqual(
        BIN_HZ,
      );
    }
  });

  it("tracks a frequency change during playback rather than smearing it", () => {
    const slow = tone(8, 4);
    const fast = tone(8, 18, 30, 11);
    const epochs = ingestToEpochs(slow).concat(ingestToEpochs(fast));
    expect(hzForColumn(argMax(epochs[3]!.spectrum))).toBeCloseTo(4, 0);
    expect(hzForColumn(argMax(epochs.at(-1)!.spectrum))).toBeCloseTo(18, 0);
  });

  it("agrees bin for bin with the paired FFT used for bilateral lanes", () => {
    const left = tone(4, 10, 30, 3);
    const right = tone(4, 20, 18, 9);
    const [pa, pb] = computePsdPair(left, right, FS);
    const sa = computePsd(left, FS);
    const sb = computePsd(right, FS);
    for (let k = 0; k < sa.power.length; k += 1) {
      expect(pa.power[k]!).toBeCloseTo(sa.power[k]!, 8);
      expect(pb.power[k]!).toBeCloseTo(sb.power[k]!, 8);
    }
  });

  it("detrends baseline drift instead of reporting it as delta", () => {
    const clean = tone(4, 10);
    const drifting = Float64Array.from(clean, (v, i) => v + 200 * (i / clean.length));
    const a = computePsd(clean, FS);
    const b = computePsd(drifting, FS);
    expect(bandPower(b, DSA_MIN_HZ, 4)).toBeLessThan(bandPower(a, DSA_MIN_HZ, 4) * 5 + 1);
    expect(bandPower(b, 9, 11)).toBeCloseTo(bandPower(a, 9, 11), 6);
  });
});
