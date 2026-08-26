/**
 * End-to-end: a full monitoring session driven by a Muse 2 device emulator.
 *
 * The emulator behaves like the real headband: four electrodes sampled at
 * 256 Hz, delivered as 12-sample Bluetooth notifications with per-frame
 * timing jitter, a monotonically increasing packet counter and the occasional
 * dropped notification. Frames are pushed through the same ingest path the
 * monitor uses (per-sample IIR filter chain into a ring buffer) and analysed
 * once a second on the trailing 4 s window.
 *
 * What this asserts over an eight-minute scripted session:
 *   - latency: per-frame ingest cost and ingestion-to-DSA-column latency stay
 *     inside the agreed budgets, and do not degrade as the session grows,
 *   - continuous-window buffering: every analysis window holds exactly the
 *     last 4 s of filtered samples (checked against an independent shadow
 *     recording), consecutive windows overlap by exactly one hop, and the ring
 *     buffer stays correct across many wraps,
 *   - event detection: the scripted suppression episode and ictal run are both
 *     detected inside their labelled spans, and the anaesthetic baseline
 *     produces no suppression or seizure events.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  EPOCH_SECONDS,
  EegAnalyzer,
  type DetectedEvent,
  type Epoch,
} from "./analysis";
import {
  MUSE_SAMPLE_RATE,
  computePsdPair,
  makeEegFilter,
  signalQuality,
} from "./dsp";

const FS = MUSE_SAMPLE_RATE; // 256 Hz
const CHUNK = 12; // samples per Bluetooth notification
const CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;
const PAIRS: Array<[string, string]> = [
  ["TP9", "AF7"],
  ["AF8", "TP10"],
];
const EPOCH_LEN = EPOCH_SECONDS * FS;
const BUFFER_LEN = FS * 60; // 60 s ring buffer, as the monitor keeps
const SESSION_SECONDS = 480; // eight-minute scripted session

/** Scripted phases of the emulated session, in seconds. */
const SUPPRESSION = { start: 120, end: 180 };
const ICTAL = { start: 240, end: 320 };
/** Half the analysis window: an episode is recognised ~2 s after it starts. */
const EDGE_LATENCY = EPOCH_SECONDS / 2;
const EDGE_TOLERANCE = 6;

/** Budgets in milliseconds. */
const FRAME_BUDGET_MS = 40; // handling one 4-channel notification
const COLUMN_BUDGET = { max: 250, p95: 120, median: 80 };

/** One dropped notification roughly every 40 s of playback — normal BLE. */
const DROP_EVERY = Math.round((40 * FS) / CHUNK);

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

// ---------------------------------------------------------------------------
// Device emulator
// ---------------------------------------------------------------------------

interface Frame {
  /** Monotonic notification counter, as the headband reports. */
  seq: number;
  /** Device timestamp of the first sample in the frame, seconds. */
  t: number;
  /** 12 samples per electrode, in CHANNELS order. */
  samples: Float64Array[];
}

/** Raw µV for one electrode at time `t`, following the scripted session. */
function emulatedSample(t: number, ch: number, noise: () => number): number {
  const jitterFreq = 1.2 + ch * 0.03;
  if (t >= SUPPRESSION.start && t < SUPPRESSION.end) {
    // Isoelectric: flat trace with only low-amplitude instrument noise.
    return 2.2 * noise();
  }
  if (t >= ICTAL.start && t < ICTAL.end) {
    // Evolving rhythmic 3 Hz discharge with a sharp harmonic component.
    const ramp = Math.min(1, (t - ICTAL.start) / 12);
    const amp = 55 * ramp;
    const phase = 2 * Math.PI * 3 * t;
    return (
      amp * Math.sin(phase) +
      0.45 * amp * Math.sin(2 * phase + 0.4) +
      0.2 * amp * Math.sin(3 * phase) +
      4 * noise()
    );
  }
  // Maintenance anaesthesia: dominant delta with waxing/waning alpha spindles.
  const spindle = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.06 * t + ch);
  return (
    30 * Math.sin(2 * Math.PI * jitterFreq * t) +
    16 * Math.sin(2 * Math.PI * 10.2 * t) * spindle +
    6 * Math.sin(2 * Math.PI * 4.3 * t + ch) +
    7 * noise()
  );
}

/** Yields Muse-shaped notification frames for the whole scripted session. */
function* emulator(): Generator<Frame> {
  const noises = CHANNELS.map((_, i) => rng(2_003 + i * 7919));
  const total = SESSION_SECONDS * FS;
  let seq = 0;
  for (let start = 0; start + CHUNK <= total; start += CHUNK) {
    seq += 1;
    // Occasional dropped notification: the sequence number still advances.
    if (seq % DROP_EVERY === 0) continue;
    const samples = CHANNELS.map((_, ci) => {
      const out = new Float64Array(CHUNK);
      for (let i = 0; i < CHUNK; i += 1) {
        out[i] = emulatedSample((start + i) / FS, ci, noises[ci]!);
      }
      return out;
    });
    yield { seq, t: start / FS, samples };
  }
}

// ---------------------------------------------------------------------------
// Ingest: filter chain + ring buffer, exactly as the monitor does
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

interface Run {
  epochs: Epoch[];
  events: DetectedEvent[];
  frameTimes: number[];
  columnLatency: number[];
  frames: number;
  drops: number;
  /** Windows whose content did not match the shadow recording. */
  windowMismatches: number;
  /** Windows whose overlap with the previous window was not exactly one hop. */
  overlapMismatches: number;
  finite: boolean;
}

function replay(): Run {
  const buffers: Record<string, Buf> = {};
  for (const ch of CHANNELS) buffers[ch] = makeBuf();
  const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);

  /** Independent record of every filtered sample on the reference electrode. */
  const shadow: number[] = [];

  const epochs: Epoch[] = [];
  const frameTimes: number[] = [];
  const columnLatency: number[] = [];
  let windowMismatches = 0;
  let overlapMismatches = 0;
  let finite = true;
  let frames = 0;
  let drops = 0;
  let lastSeq = 0;
  let written = 0;
  let nextEpochAt = EPOCH_LEN;
  let lastFrameEnd = 0;
  let prevWindow: Float64Array | null = null;

  for (const frame of emulator()) {
    drops += frame.seq - lastSeq - 1;
    lastSeq = frame.seq;
    frames += 1;

    const frameStart = performance.now();
    CHANNELS.forEach((ch, ci) => {
      const buf = buffers[ch]!;
      const src = frame.samples[ci]!;
      for (let i = 0; i < CHUNK; i += 1) {
        const v = buf.filter.process(src[i]!);
        buf.data[buf.write] = v;
        buf.write = (buf.write + 1) % BUFFER_LEN;
        if (buf.count < BUFFER_LEN) buf.count += 1;
        if (ci === 0) shadow.push(v);
      }
    });
    written += CHUNK;
    lastFrameEnd = performance.now();
    frameTimes.push(lastFrameEnd - frameStart);

    if (written < nextEpochAt) continue;
    nextEpochAt += FS;

    // Signal quality: one paired FFT per electrode pair, as the monitor runs.
    for (const [a, b] of PAIRS) {
      const segA = readLast(buffers[a]!, FS * 2);
      const segB = readLast(buffers[b]!, FS * 2);
      const [psdA, psdB] = computePsdPair(segA, segB, FS);
      signalQuality(segA, psdA, FS);
      signalQuality(segB, psdB, FS);
    }

    // Continuous-window buffering checks on the reference electrode.
    const ref = readLast(buffers[CHANNELS[0]]!, EPOCH_LEN);
    for (let i = 0; i < EPOCH_LEN; i += 1) {
      if (ref[i] !== shadow[shadow.length - EPOCH_LEN + i]) {
        windowMismatches += 1;
        break;
      }
    }
    if (prevWindow) {
      const hop = FS; // one second between ticks
      for (let i = 0; i < EPOCH_LEN - hop; i += 1) {
        if (prevWindow[i + hop] !== ref[i]) {
          overlapMismatches += 1;
          break;
        }
      }
    }
    prevWindow = ref;

    // Primary window: four-electrode average.
    const avg = new Float64Array(EPOCH_LEN);
    for (const ch of CHANNELS) {
      const seg = readLast(buffers[ch]!, EPOCH_LEN);
      for (let i = 0; i < EPOCH_LEN; i += 1) avg[i]! += seg[i]! / CHANNELS.length;
    }
    const epoch = analyzer.analyze(avg, written / FS);
    columnLatency.push(performance.now() - lastFrameEnd);
    if (
      !Number.isFinite(epoch.sef95) ||
      !Number.isFinite(epoch.suppressionRatio) ||
      !Number.isFinite(epoch.seizureScore) ||
      epoch.spectrum.some((v) => !Number.isFinite(v))
    ) {
      finite = false;
    }
    epochs.push(epoch);
  }

  return {
    epochs,
    events: [...analyzer.events],
    frameTimes,
    columnLatency,
    frames,
    drops,
    windowMismatches,
    overlapMismatches,
    finite,
  };
}

const TIMEOUT = 180_000;

describe("full monitoring session from a Muse 2 device emulator", () => {
  const run = replay();
  const inSpan = (e: DetectedEvent, span: { start: number; end: number }) =>
    e.t + e.duration > span.start - EDGE_TOLERANCE &&
    e.t < span.end + EDGE_LATENCY + EDGE_TOLERANCE;

  it("streams the whole session and produces one DSA column per second", () => {
    expect(run.frames).toBeGreaterThan(9_000);
    expect(run.drops).toBeGreaterThan(0); // the emulator did drop notifications
    expect(run.epochs.length).toBeGreaterThan(SESSION_SECONDS - EPOCH_SECONDS - 5);
    for (let i = 1; i < run.epochs.length; i += 1) {
      expect(run.epochs[i]!.t - run.epochs[i - 1]!.t).toBeCloseTo(1, 1);
      expect(run.epochs[i]!.spectrum.length).toBe(run.epochs[0]!.spectrum.length);
    }
    expect(run.finite).toBe(true);
  }, TIMEOUT);

  it("keeps every analysis window continuously buffered and correctly aligned", () => {
    // Each window is byte-for-byte the trailing 4 s of the filtered stream...
    expect(run.windowMismatches).toBe(0);
    // ...and consecutive windows overlap by exactly one hop, across many
    // wraps of the 60 s ring buffer.
    expect(run.overlapMismatches).toBe(0);
    expect(run.epochs.length * FS).toBeGreaterThan(BUFFER_LEN * 5);
  }, TIMEOUT);

  it("meets the ingest and ingestion-to-column latency budgets", () => {
    expect(Math.max(...run.frameTimes)).toBeLessThan(FRAME_BUDGET_MS);
    expect(quantile(run.frameTimes, 0.95)).toBeLessThan(FRAME_BUDGET_MS / 4);
    expect(Math.max(...run.columnLatency)).toBeLessThan(COLUMN_BUDGET.max);
    expect(quantile(run.columnLatency, 0.95)).toBeLessThan(COLUMN_BUDGET.p95);
    expect(quantile(run.columnLatency, 0.5)).toBeLessThan(COLUMN_BUDGET.median);

    // Ingest plus analysis fits comfortably inside the one-second cadence.
    const perSecond = mean(run.frameTimes) * (FS / CHUNK) + mean(run.columnLatency);
    expect(perSecond).toBeLessThan(500);
  }, TIMEOUT);

  it("does not slow down as the session grows", () => {
    const n = run.columnLatency.length;
    const first = run.columnLatency.slice(0, Math.floor(n / 4));
    const last = run.columnLatency.slice(-Math.floor(n / 4));
    expect(quantile(last, 0.9)).toBeLessThan(COLUMN_BUDGET.max);
    expect(mean(last)).toBeLessThan(Math.max(mean(first) * 3, 20));
  }, TIMEOUT);

  it("detects the scripted suppression episode inside its labelled span", () => {
    const suppEvents = run.events.filter(
      (e) => e.kind === "burst_suppression" || e.kind === "isoelectric",
    );
    expect(suppEvents.length).toBeGreaterThan(0);
    for (const e of suppEvents) {
      expect(inSpan(e, SUPPRESSION), `suppression event at t=${e.t} outside span`).toBe(true);
    }

    // The suppression ratio rises inside the episode and settles afterwards.
    const at = (t: number) => run.epochs.find((e) => Math.abs(e.t - t) < 1);
    expect(at(SUPPRESSION.end - 5)!.suppressionRatio).toBeGreaterThan(50);
    expect(at(SUPPRESSION.start - 10)!.suppressionRatio).toBeLessThan(10);
    expect(at(SESSION_SECONDS - 10)!.suppressionRatio).toBeLessThan(10);

    const suppressedEpochs = run.epochs.filter((e) => e.isSuppressed).map((e) => e.t);
    expect(suppressedEpochs.length).toBeGreaterThan(30);
    expect(Math.min(...suppressedEpochs)).toBeGreaterThanOrEqual(SUPPRESSION.start);
    expect(Math.max(...suppressedEpochs)).toBeLessThanOrEqual(
      SUPPRESSION.end + EDGE_LATENCY + EDGE_TOLERANCE,
    );
  }, TIMEOUT);

  it("alerts during the scripted ictal run and nowhere else", () => {
    const alerts = run.epochs.filter((e) => e.seizureAlert).map((e) => e.t);
    expect(alerts.length).toBeGreaterThan(0);
    for (const t of alerts) {
      expect(t, `seizure alert at t=${t} outside ictal span`).toBeGreaterThanOrEqual(
        ICTAL.start,
      );
      expect(t).toBeLessThanOrEqual(ICTAL.end + EDGE_LATENCY + EDGE_TOLERANCE);
    }
    for (const e of run.events.filter((x) => x.kind === "seizure")) {
      expect(inSpan(e, ICTAL), `seizure event at t=${e.t} outside span`).toBe(true);
    }
  }, TIMEOUT);

  it("stays quiet through the anaesthetic baseline", () => {
    const baseline = run.epochs.filter(
      (e) =>
        e.t < SUPPRESSION.start - EDGE_TOLERANCE ||
        (e.t > SUPPRESSION.end + EDGE_TOLERANCE + EDGE_LATENCY &&
          e.t < ICTAL.start - EDGE_TOLERANCE) ||
        e.t > ICTAL.end + EDGE_TOLERANCE + EDGE_LATENCY,
    );
    expect(baseline.length).toBeGreaterThan(200);
    expect(baseline.some((e) => e.isSuppressed)).toBe(false);
    expect(baseline.some((e) => e.seizureAlert)).toBe(false);
    // The baseline is a plausible anaesthetic trace, not junk.
    expect(mean(baseline.map((e) => e.sef95))).toBeGreaterThan(5);
    expect(mean(baseline.map((e) => e.sef95))).toBeLessThan(25);
  }, TIMEOUT);
});
