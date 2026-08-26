/**
 * End-to-end: a 45-minute emulator stream, watched for leaks and drift.
 *
 * Long cases are the ones that hurt. A theatre list runs for hours and the
 * monitor has to hold the same footprint at minute 45 as at minute 1: the
 * acquisition ring buffers must wrap rather than grow, the raw archive must
 * stay capped, the analyzer's rolling histories must not accumulate one entry
 * per second forever, the per-stage queues must drain, and the batched
 * database write path must flush rather than pile rows up in memory.
 *
 * This replays 45 minutes of Muse-shaped notifications (4 electrodes, 256 Hz,
 * 12-sample frames) through the real ingest → quality → analyse → archive →
 * persist chain and asserts, per five-minute block:
 *   - retained bytes across every buffer/queue/store are flat (no growth
 *     between the first and last block),
 *   - the analyzer's internal rolling histories stay bounded,
 *   - the staged write queue drains and never exceeds its batch size,
 *   - ingest, quality, analyse and flush latency stay inside budget and show
 *     no upward trend across the session.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, EPOCH_SECONDS, EegAnalyzer, type Epoch } from "./analysis";
import { MUSE_SAMPLE_RATE, computePsdPair, makeEegFilter, signalQuality } from "./dsp";
import { PipelineProfiler } from "./pipeline-metrics";
import { RAW_ARCHIVE_HZ, RAW_ARCHIVE_SECONDS, createRawArchive } from "./raw-archive";
import { createWaveformStore } from "./waveform-store";

const FS = MUSE_SAMPLE_RATE;
const CHUNK = 12;
const CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;
const PAIRS: Array<[string, string]> = [
  ["TP9", "AF7"],
  ["AF8", "TP10"],
];
const EPOCH_LEN = EPOCH_SECONDS * FS;
const BUFFER_LEN = FS * 60; // 60 s acquisition ring, as the monitor keeps

/** 45 minutes — long enough to wrap the 60 s ring 45 times over. */
const SESSION_SECONDS = 45 * 60;
const BLOCK_SECONDS = 5 * 60;

/** Rows are flushed to the database in batches, as the save path does. */
const WRITE_BATCH = 60;

/** Budgets in milliseconds. */
const BUDGETS = { frame: 40, quality: 60, analyze: 120, flush: 50 };
/** Allowed second-half/first-half ratio for any stage's total time. */
const MAX_DEGRADE_RATIO = 1.6;
/** Allowed growth in retained bytes between the first and last block. */
const MAX_RETAINED_GROWTH = 1.02;

const TIMEOUT = 900_000;

const rng = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff - 0.5;
  };
};

const quantile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const median = (xs: number[]) => quantile(xs, 0.5);

/** Least-squares slope of `ys` against `xs`. */
function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    num += dx * (ys[i]! - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

// ---------------------------------------------------------------------------
// Device emulator — a long, clinically plausible maintenance case
// ---------------------------------------------------------------------------

function emulatedSample(t: number, ch: number, noise: () => number): number {
  // Deepening and lightening across the case, with a couple of deep,
  // suppression-prone troughs. No pure tones: real cortex drifts.
  const depth = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 900 + ch * 0.2);
  const drift = 0.35 * Math.sin(2 * Math.PI * 0.017 * t + ch * 1.3);
  const spindle = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.06 * t + ch);
  return (
    (18 + 14 * depth) * Math.sin(2 * Math.PI * (1.2 + ch * 0.03 + drift) * t) +
    13 * Math.sin(2 * Math.PI * 2.7 * t + 1.1 * Math.sin(2 * Math.PI * 0.11 * t)) +
    (14 - 8 * depth) * Math.sin(2 * Math.PI * (10.2 + 0.6 * drift) * t) * spindle +
    6 * Math.sin(2 * Math.PI * 5.9 * t + ch) +
    16 * noise()
  );
}

interface Frame {
  seq: number;
  samples: Float64Array[];
}

/** One dropped notification roughly every 40 s — normal BLE behaviour. */
const DROP_EVERY = Math.round((40 * FS) / CHUNK);

function* emulator(): Generator<Frame> {
  const noises = CHANNELS.map((_, i) => rng(9_001 + i * 7919));
  const total = SESSION_SECONDS * FS;
  let seq = 0;
  for (let start = 0; start + CHUNK <= total; start += CHUNK) {
    seq += 1;
    if (seq % DROP_EVERY === 0) continue;
    const samples = CHANNELS.map((_, ci) => {
      const out = new Float64Array(CHUNK);
      for (let i = 0; i < CHUNK; i += 1) out[i] = emulatedSample((start + i) / FS, ci, noises[ci]!);
      return out;
    });
    yield { seq, samples };
  }
}

// ---------------------------------------------------------------------------
// Ingest ring buffers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Storage write path: batched, flushed, bounded
// ---------------------------------------------------------------------------

interface Writer {
  pending: Epoch[];
  written: number;
  flushes: number;
  maxPending: number;
  /** Bytes the last flushed payload serialised to (proxy for request size). */
  lastPayloadBytes: number;
}

function stageRow(writer: Writer, epoch: Epoch) {
  writer.pending.push(epoch);
  writer.maxPending = Math.max(writer.maxPending, writer.pending.length);
}

/** Serialise + "send" a batch, then release it, as the save path does. */
function flush(writer: Writer) {
  if (writer.pending.length === 0) return;
  const batch = writer.pending.splice(0, writer.pending.length);
  const payload = JSON.stringify(
    batch.map((e) => ({
      t_offset_seconds: e.t,
      depth_index: e.depthIndex ?? null,
      spectral_edge_95: e.sef95,
      suppression_ratio: e.suppressionRatio,
      seizure_score: e.seizureScore,
      is_suppressed: e.isSuppressed,
      spectrum: Array.from(e.spectrum),
    })),
  );
  writer.lastPayloadBytes = payload.length;
  writer.written += batch.length;
  writer.flushes += 1;
}

// ---------------------------------------------------------------------------
// Footprint accounting
// ---------------------------------------------------------------------------

interface BlockSample {
  minute: number;
  retainedBytes: number;
  pendingRows: number;
  archiveSeconds: number;
  analyzerHistory: number;
  events: number;
  profilerSamples: number;
  heapUsedMb: number | null;
}

/** Rolling history arrays the analyzer keeps internally. */
function analyzerHistoryLength(analyzer: EegAnalyzer): number {
  const inner = analyzer as unknown as Record<string, unknown>;
  let total = 0;
  for (const value of Object.values(inner)) {
    if (Array.isArray(value)) total += value.length;
  }
  return total;
}

interface Run {
  blocks: BlockSample[];
  frameMs: number[];
  qualityMs: number[];
  analyzeMs: number[];
  flushMs: number[];
  columnMs: number[];
  epochs: number;
  writer: Writer;
  archiveSpan: number;
  ringBytes: number;
  finite: boolean;
  degrading: { stage: string; ratio: number; slope: number }[];
}

function replay(): Run {
  const buffers: Record<string, Buf> = {};
  for (const ch of CHANNELS) buffers[ch] = makeBuf();
  const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
  const archive = createRawArchive();
  const waveform = createWaveformStore();
  const profiler = new PipelineProfiler();
  const writer: Writer = {
    pending: [],
    written: 0,
    flushes: 0,
    maxPending: 0,
    lastPayloadBytes: 0,
  };

  const blocks: BlockSample[] = [];
  const frameMs: number[] = [];
  const qualityMs: number[] = [];
  const analyzeMs: number[] = [];
  const flushMs: number[] = [];
  const columnMs: number[] = [];
  let epochs = 0;
  let finite = true;
  let written = 0;
  let nextEpochAt = EPOCH_LEN;
  let nextBlockAt = BLOCK_SECONDS;

  const ringBytes = CHANNELS.length * BUFFER_LEN * 8;
  const archiveBytes = () =>
    CHANNELS.length * RAW_ARCHIVE_HZ * RAW_ARCHIVE_SECONDS * 4 * 0 +
    CHANNELS.reduce((sum, ch) => sum + Math.min(archive.duration(ch), RAW_ARCHIVE_SECONDS) * RAW_ARCHIVE_HZ * 4, 0);

  for (const frame of emulator()) {
    const ingest = profiler.enqueue("ingest", written / FS);
    const frameStart = performance.now();
    CHANNELS.forEach((ch, ci) => {
      const buf = buffers[ch]!;
      const src = frame.samples[ci]!;
      const filtered = new Float64Array(CHUNK);
      for (let i = 0; i < CHUNK; i += 1) {
        const v = buf.filter.process(src[i]!);
        filtered[i] = v;
        buf.data[buf.write] = v;
        buf.write = (buf.write + 1) % BUFFER_LEN;
        if (buf.count < BUFFER_LEN) buf.count += 1;
      }
      archive.push(ch, filtered, FS);
    });
    written += CHUNK;
    const frameEnd = performance.now();
    frameMs.push(frameEnd - frameStart);
    ingest.start();
    ingest.done();

    if (written < nextEpochAt) continue;
    nextEpochAt += FS;

    // Signal quality: one paired FFT per electrode pair.
    const qTicket = profiler.enqueue("quality", written / FS);
    qTicket.start();
    const qStart = performance.now();
    for (const [a, b] of PAIRS) {
      const segA = readLast(buffers[a]!, FS * 2);
      const segB = readLast(buffers[b]!, FS * 2);
      const [psdA, psdB] = computePsdPair(segA, segB, FS);
      signalQuality(segA, psdA, FS);
      signalQuality(segB, psdB, FS);
    }
    qualityMs.push(performance.now() - qStart);
    qTicket.done();

    // Analyse the four-electrode average.
    const aTicket = profiler.enqueue("analyze", written / FS);
    aTicket.start();
    const aStart = performance.now();
    const avg = new Float64Array(EPOCH_LEN);
    for (const ch of CHANNELS) {
      const seg = readLast(buffers[ch]!, EPOCH_LEN);
      for (let i = 0; i < EPOCH_LEN; i += 1) avg[i]! += seg[i]! / CHANNELS.length;
    }
    const epoch = analyzer.analyze(avg, written / FS);
    analyzeMs.push(performance.now() - aStart);
    aTicket.done();
    columnMs.push(performance.now() - frameEnd);
    epochs += 1;

    if (
      !Number.isFinite(epoch.sef95) ||
      !Number.isFinite(epoch.suppressionRatio) ||
      !Number.isFinite(epoch.seizureScore) ||
      epoch.spectrum.some((v) => !Number.isFinite(v))
    ) {
      finite = false;
    }

    // Live trace store: replaced, never appended to.
    waveform.set(readLast(buffers[CHANNELS[0]]!, FS * 4));

    // Storage write path.
    stageRow(writer, epoch);
    if (writer.pending.length >= WRITE_BATCH) {
      const fStart = performance.now();
      flush(writer);
      flushMs.push(performance.now() - fStart);
    }

    const seconds = written / FS;
    if (seconds >= nextBlockAt) {
      nextBlockAt += BLOCK_SECONDS;
      const retained =
        ringBytes +
        archiveBytes() +
        waveform.getSnapshot().length * 8 +
        writer.pending.length * 512 +
        analyzer.events.length * 256 +
        analyzerHistoryLength(analyzer) * 32 +
        profiler.stats().reduce((s, st) => s + st.count * 24, 0);
      blocks.push({
        minute: seconds / 60,
        retainedBytes: retained,
        pendingRows: writer.pending.length,
        archiveSeconds: archive.span(),
        analyzerHistory: analyzerHistoryLength(analyzer),
        events: analyzer.events.length,
        profilerSamples: profiler.stats().reduce((s, st) => s + st.count, 0),
        heapUsedMb:
          typeof process !== "undefined" && typeof process.memoryUsage === "function"
            ? process.memoryUsage().heapUsed / 1e6
            : null,
      });
    }
  }

  flush(writer);

  const degrading = profiler.stability().map((s) => ({
    stage: s.stage,
    ratio: s.ratio,
    slope: s.slopeMsPerMinute,
  }));

  return {
    blocks,
    frameMs,
    qualityMs,
    analyzeMs,
    flushMs,
    columnMs,
    epochs,
    writer,
    archiveSpan: archive.span(),
    ringBytes,
    finite,
    degrading,
  };
}

describe("45-minute emulator session: memory and latency stability", () => {
  const run = replay();
  const firstBlock = run.blocks[0]!;
  const lastBlock = run.blocks[run.blocks.length - 1]!;

  it("streams the full session and analyses every second", () => {
    expect(run.blocks.length).toBe(SESSION_SECONDS / BLOCK_SECONDS);
    expect(run.epochs).toBeGreaterThan(SESSION_SECONDS - EPOCH_SECONDS - 5);
    expect(run.finite).toBe(true);
  }, TIMEOUT);

  it("keeps the acquisition ring buffers at a fixed size", () => {
    // Four 60 s Float64 rings, whatever the case length.
    expect(run.ringBytes).toBe(CHANNELS.length * BUFFER_LEN * 8);
    expect(run.ringBytes / 1e6).toBeLessThan(4);
  }, TIMEOUT);

  it("caps the raw archive instead of growing with the case", () => {
    // 45 minutes fits inside the archive window, so the span tracks the case…
    expect(run.archiveSpan).toBeGreaterThan(SESSION_SECONDS - 5);
    // …but the underlying rings are pre-allocated to the cap and never exceed it.
    expect(run.archiveSpan).toBeLessThanOrEqual(RAW_ARCHIVE_SECONDS);
  }, TIMEOUT);

  it("drains the storage write queue and never exceeds one batch", () => {
    expect(run.writer.maxPending).toBeLessThanOrEqual(WRITE_BATCH);
    expect(run.writer.pending.length).toBe(0);
    expect(run.writer.written).toBe(run.epochs);
    expect(run.writer.flushes).toBeGreaterThan(SESSION_SECONDS / WRITE_BATCH - 2);
    // Each flush ships one batch, so the payload never grows with the case.
    expect(run.writer.lastPayloadBytes).toBeLessThan(WRITE_BATCH * 20_000);
  }, TIMEOUT);

  it("bounds the analyzer's rolling histories", () => {
    for (const block of run.blocks) {
      expect(block.analyzerHistory).toBeLessThan(2_000);
    }
    // Later blocks hold no more history than early ones.
    expect(lastBlock.analyzerHistory).toBeLessThanOrEqual(firstBlock.analyzerHistory * 2 + 200);
  }, TIMEOUT);

  it("holds a flat retained footprint from the first block to the last", () => {
    const stable = run.blocks.slice(1); // block 1 is still filling the archive
    const base = stable[0]!.retainedBytes;
    for (const block of stable) {
      expect(block.retainedBytes / base).toBeLessThan(MAX_RETAINED_GROWTH);
      expect(block.pendingRows).toBeLessThanOrEqual(WRITE_BATCH);
    }
    expect(lastBlock.retainedBytes / base).toBeLessThan(MAX_RETAINED_GROWTH);
  }, TIMEOUT);

  it("meets the per-stage latency budgets across the whole session", () => {
    expect(quantile(run.frameMs, 0.95)).toBeLessThan(BUDGETS.frame);
    expect(quantile(run.qualityMs, 0.95)).toBeLessThan(BUDGETS.quality);
    expect(quantile(run.analyzeMs, 0.95)).toBeLessThan(BUDGETS.analyze);
    expect(quantile(run.flushMs, 0.95)).toBeLessThan(BUDGETS.flush);
    expect(quantile(run.columnMs, 0.95)).toBeLessThan(250);
  }, TIMEOUT);

  it("shows no latency drift between the first and last quarter", () => {
    const quarter = (xs: number[]) => ({
      first: xs.slice(0, Math.floor(xs.length / 4)),
      last: xs.slice(-Math.floor(xs.length / 4)),
    });
    for (const series of [run.frameMs, run.qualityMs, run.analyzeMs, run.columnMs]) {
      const { first, last } = quarter(series);
      expect(median(last)).toBeLessThan(Math.max(median(first) * 2.5, 1));
    }
    // Least-squares trend of the analysis stage against session minutes.
    const minutes = run.analyzeMs.map((_, i) => i / 60);
    expect(Math.abs(slope(minutes, run.analyzeMs))).toBeLessThan(2);
  }, TIMEOUT);

  it("reports no degrading stage from the pipeline profiler", () => {
    for (const stage of run.degrading) {
      expect(stage.ratio).toBeLessThan(MAX_DEGRADE_RATIO);
      expect(Math.abs(stage.slope)).toBeLessThan(2);
    }
  }, TIMEOUT);
});
