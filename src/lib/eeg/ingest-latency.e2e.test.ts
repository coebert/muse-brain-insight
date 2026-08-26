/**
 * End-to-end: ingestion-to-DSA latency during continuous playback.
 *
 * Replays a Muse 2-shaped stream (4 electrodes, 256 Hz, 12-sample
 * notifications) through the real ingest path — per-sample IIR filter chain,
 * ring buffers — and then runs the per-second analysis tick exactly as the
 * monitor does: paired FFT signal quality for every electrode pair followed
 * by `EegAnalyzer.analyze` on the 4 s primary window.
 *
 * Latency is measured from the moment the last sample of an epoch is
 * ingested to the moment that epoch's DSA column (`Epoch.spectrum`) exists.
 * The agreed budget is well inside the 1 s repaint cadence so the newest
 * column is always on screen before the next one is due.
 */
import { describe, expect, it } from "vitest";

import { EegAnalyzer, type Epoch } from "@/lib/eeg/analysis";
import {
  MUSE_SAMPLE_RATE,
  computePsdPair,
  makeEegFilter,
  signalQuality,
} from "@/lib/eeg/dsp";

const FS = MUSE_SAMPLE_RATE; // 256 Hz
const CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;
/** Electrodes are rated in pairs, one complex FFT per pair. */
const PAIRS: Array<[string, string]> = [
  ["TP9", "AF7"],
  ["AF8", "TP10"],
];
const CHUNK = 12; // samples per Bluetooth notification
const EPOCH_SECONDS = 4;
const EPOCH_LEN = FS * EPOCH_SECONDS;
const BUFFER_LEN = FS * 60;
const SESSION_SECONDS = 300; // 5 minutes of continuous playback

/** Agreed budgets, in milliseconds, per epoch. */
const BUDGET = { max: 250, p95: 120, median: 80 };
/** Budget for handling one Bluetooth notification (12 samples, 4 channels). */
const CHUNK_BUDGET_MS = 4;

interface Buf {
  data: Float64Array;
  write: number;
  count: number;
  filter: ReturnType<typeof makeEegFilter>;
}

const makeBuf = (): Buf => ({
  data: new Float64Array(BUFFER_LEN),
  write: 0,
  count: 0,
  filter: makeEegFilter(),
});

function readLast(buf: Buf, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = buf.data[(buf.write - n + i + BUFFER_LEN * 2) % BUFFER_LEN]!;
  }
  return out;
}

/** Deterministic anaesthesia-like EEG: delta + alpha spindles + noise. */
function sample(t: number, seedRef: { s: number }): number {
  seedRef.s = (seedRef.s * 1103515245 + 12345) % 2147483648;
  const noise = seedRef.s / 2147483648 - 0.5;
  return (
    28 * Math.sin(2 * Math.PI * 1.4 * t) +
    18 * Math.sin(2 * Math.PI * 10 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.07 * t)) +
    6 * Math.sin(2 * Math.PI * 4 * t) +
    8 * noise
  );
}

const quantile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

interface Run {
  latencies: number[];
  chunkTimes: number[];
  epochs: Epoch[];
}

function replay(): Run {
  const buffers: Record<string, Buf> = {};
  for (const c of CHANNELS) buffers[c] = makeBuf();
  const analyzer = new EegAnalyzer(undefined, FS);
  const seeds = CHANNELS.map((_, i) => ({ s: 17 + i * 991 }));

  const latencies: number[] = [];
  const chunkTimes: number[] = [];
  const epochs: Epoch[] = [];

  let written = 0; // samples ingested per channel
  let nextEpochAt = EPOCH_LEN; // analyse once a full window exists, then hourly ticks
  let lastChunkEnd = 0;

  while (written < SESSION_SECONDS * FS) {
    // --- ingest one Bluetooth notification for every electrode -------------
    const chunkStart = performance.now();
    CHANNELS.forEach((ch, ci) => {
      const buf = buffers[ch]!;
      for (let i = 0; i < CHUNK; i += 1) {
        const t = (written + i) / FS;
        const v = buf.filter.process(sample(t, seeds[ci]!));
        buf.data[buf.write] = v;
        buf.write = (buf.write + 1) % BUFFER_LEN;
        if (buf.count < BUFFER_LEN) buf.count += 1;
      }
    });
    written += CHUNK;
    lastChunkEnd = performance.now();
    chunkTimes.push(lastChunkEnd - chunkStart);

    // --- per-second analysis tick -----------------------------------------
    if (written >= nextEpochAt) {
      nextEpochAt += FS;
      // Signal quality: one paired FFT per electrode pair.
      for (const [a, b] of PAIRS) {
        const segA = readLast(buffers[a]!, FS * 2);
        const segB = readLast(buffers[b]!, FS * 2);
        const [psdA, psdB] = computePsdPair(segA, segB, FS);
        signalQuality(segA, psdA, FS);
        signalQuality(segB, psdB, FS);
      }
      // Primary window: four-electrode average, as the monitor uses.
      const avg = new Float64Array(EPOCH_LEN);
      for (const ch of CHANNELS) {
        const seg = readLast(buffers[ch]!, EPOCH_LEN);
        for (let i = 0; i < EPOCH_LEN; i += 1) avg[i]! += seg[i]! / CHANNELS.length;
      }
      const epoch = analyzer.analyze(avg, written / FS);
      const done = performance.now();
      expect(epoch.spectrum.length).toBeGreaterThan(0);
      epochs.push(epoch);
      latencies.push(done - lastChunkEnd);
    }
  }

  return { latencies, chunkTimes, epochs };
}

describe("ingestion-to-DSA latency during continuous playback", () => {
  const run = replay();

  it("produces one DSA column per second of playback", () => {
    expect(run.epochs.length).toBe(SESSION_SECONDS - EPOCH_SECONDS + 1);
    for (let i = 1; i < run.epochs.length; i += 1) {
      // Ticks land on notification boundaries, so allow one chunk of jitter.
      expect(run.epochs[i]!.t - run.epochs[i - 1]!.t).toBeCloseTo(1, 1);
    }
  });

  it("keeps every epoch's ingestion-to-column latency inside the agreed budget", () => {
    const max = Math.max(...run.latencies);
    const p95 = quantile(run.latencies, 0.95);
    const median = quantile(run.latencies, 0.5);
    expect(max).toBeLessThan(BUDGET.max);
    expect(p95).toBeLessThan(BUDGET.p95);
    expect(median).toBeLessThan(BUDGET.median);
  });

  it("keeps total per-second work under real time", () => {
    const chunksPerSecond = FS / CHUNK;
    const ingestPerSecond =
      (run.chunkTimes.reduce((a, b) => a + b, 0) / run.chunkTimes.length) * chunksPerSecond;
    const analysisPerSecond =
      run.latencies.reduce((a, b) => a + b, 0) / run.latencies.length;
    expect(ingestPerSecond + analysisPerSecond).toBeLessThan(500);
    expect(Math.max(...run.chunkTimes)).toBeLessThan(CHUNK_BUDGET_MS * 10);
  });

  it("does not drift slower as the session grows", () => {
    const n = run.latencies.length;
    const first = run.latencies.slice(0, Math.floor(n / 4));
    const last = run.latencies.slice(-Math.floor(n / 4));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Late epochs may cost a little more, never several times more.
    expect(quantile(last, 0.9)).toBeLessThan(BUDGET.max);
    expect(mean(last)).toBeLessThan(Math.max(mean(first) * 3, 20));
  });
});
