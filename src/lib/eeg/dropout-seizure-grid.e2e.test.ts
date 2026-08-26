/**
 * End-to-end: latency and one-second grid alignment across a five-minute
 * session punctuated by link dropouts, reconnects and corrupted packets.
 *
 * The emulator behaves like a Muse 2 that keeps losing and regaining the
 * radio link while the patient has scripted seizure activity and a scripted
 * suppression episode. Frames go through the real ingest path (per-sample IIR
 * chain into a ring buffer), signal quality runs as paired FFTs and the
 * analyzer scores the trailing 4 s window once per whole second — the same
 * order the live monitor uses, with each stage instrumented by
 * `PipelineProfiler` so downstream stages accrue genuine queue time.
 *
 * Two contracts are asserted:
 *
 *  1. Latency. Ingestion-to-DSA-column latency stays inside the agreed budget
 *     during the dropouts, across every reconnect burst, and while corrupted
 *     packets are flowing — and it does not drift upward over the five
 *     minutes (per-minute medians, first-vs-last comparison, least-squares
 *     slope, and a dedicated look at the seconds immediately after a
 *     reconnect, when the ring buffer refills fastest).
 *
 *  2. Grid alignment. Every DSA column, every seizure onset/duration and
 *     every suppression episode lands on a whole second of case time. A
 *     dropout must shift the grid by a whole number of seconds, never a
 *     fraction, so tiles and event markers cannot slide against the timeline.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  EPOCH_SECONDS,
  EegAnalyzer,
  HOP_SECONDS,
  type DetectedEvent,
  type Epoch,
} from "./analysis";
import { MUSE_SAMPLE_RATE, computePsdPair, makeEegFilter, signalQuality } from "./dsp";
import { PipelineProfiler } from "./pipeline-metrics";

const FS = MUSE_SAMPLE_RATE; // 256 Hz
const CHUNK = 12; // samples per Bluetooth notification
const CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;
const PAIRS: Array<[string, string]> = [
  ["TP9", "AF7"],
  ["AF8", "TP10"],
];
const EPOCH_LEN = EPOCH_SECONDS * FS;
const BUFFER_LEN = FS * 60; // 60 s ring buffer, as the monitor keeps
const SESSION_SECONDS = 300; // the five-minute dropout session

interface Span {
  start: number;
  end: number;
}

/** Scripted clinical content. */
const ICTAL: Span[] = [
  { start: 55, end: 100 },
  { start: 205, end: 250 },
];
const SUPPRESSION: Span = { start: 130, end: 180 };

/**
 * Scripted link losses. Each is a complete radio dropout followed by a
 * reconnect; the second one starts inside the suppression episode and the
 * third clips the start of the second ictal run, so the grid has to survive a
 * dropout landing in the middle of a detected event.
 */
const DROPOUTS: Span[] = [
  { start: 40, end: 47 },
  { start: 148, end: 157 },
  { start: 212, end: 217 },
  { start: 268, end: 271 },
];

/** Probability that a delivered notification arrives garbled. */
const CORRUPT_RATE = 0.012;

/** Half the analysis window: an episode is recognised ~2 s after it starts. */
const EDGE_LATENCY = EPOCH_SECONDS / 2;
const EDGE_TOLERANCE = 8;

/** Agreed latency budgets, in milliseconds. */
const FRAME_BUDGET_MS = 40; // handling one 4-channel notification
const COLUMN_BUDGET = { max: 250, p95: 120, median: 80 };
/** After a reconnect the pipeline may work harder, but not out of budget. */
const RECONNECT_BUDGET_MS = 200;
/** Ingest + quality + analysis for one second of signal. */
const TICK_BUDGET_MS = 600;
/** Allowed upward creep of column latency across the session. */
const DRIFT_SLOPE_MS_PER_MINUTE = 2;

const TIMEOUT = 240_000;

const rng = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
};

const quantile = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const median = (xs: number[]) => quantile(xs, 0.5);

const inSpan = (t: number, spans: Span[]) => spans.some((s) => t >= s.start && t < s.end);

/** Least-squares slope of `ys` against `xs`. */
function slope(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

/** Whole-second alignment check, tolerant of float accumulation only. */
const onGrid = (v: number) => Math.abs(v / HOP_SECONDS - Math.round(v / HOP_SECONDS)) < 1e-9;

// ---------------------------------------------------------------------------
// Device emulator: scripted EEG, dropouts, reconnects, corrupted frames
// ---------------------------------------------------------------------------

/** Raw µV for one electrode at time `t`. */
function emulatedSample(t: number, ch: number, noise: () => number): number {
  const n = () => noise() - 0.5;
  if (t >= SUPPRESSION.start && t < SUPPRESSION.end) {
    // Burst suppression: mostly flat with a short burst every ~8 s.
    const burst = t % 8 < 0.8;
    return burst ? 60 * Math.sin(2 * Math.PI * 6 * t) + 12 * n() : 2.2 * n();
  }
  if (inSpan(t, ICTAL)) {
    const span = ICTAL.find((s) => t >= s.start && t < s.end)!;
    // Evolving rhythmic 3 Hz discharge with sharp harmonics.
    const ramp = Math.min(1, (t - span.start) / 10);
    const amp = 55 * ramp;
    const phase = 2 * Math.PI * 3 * t;
    return (
      amp * Math.sin(phase) +
      0.45 * amp * Math.sin(2 * phase + 0.4) +
      0.2 * amp * Math.sin(3 * phase) +
      4 * n()
    );
  }
  // Maintenance anaesthesia: drifting delta with waxing/waning alpha spindles.
  const spindle = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.06 * t + ch);
  const drift = 0.35 * Math.sin(2 * Math.PI * 0.017 * t + ch * 1.3);
  return (
    26 * Math.sin(2 * Math.PI * (1.2 + ch * 0.03 + drift) * t) +
    14 * Math.sin(2 * Math.PI * 2.7 * t + 1.1 * Math.sin(2 * Math.PI * 0.11 * t)) +
    13 * Math.sin(2 * Math.PI * (10.2 + 0.6 * drift) * t) * spindle +
    7 * Math.sin(2 * Math.PI * 5.9 * t + ch) +
    5 * Math.sin(2 * Math.PI * 14.3 * t + 0.7 * ch) +
    16 * n()
  );
}

interface Frame {
  seq: number;
  /** Device time of the first sample in the frame, seconds. */
  t: number;
  samples: Float64Array[];
  /** True when the frame carries garbage (NaN/Inf/spikes/short payload). */
  corrupt: boolean;
}

/**
 * Yields notifications for the whole session. Inside a scripted dropout no
 * frame is delivered at all — the sequence counter still advances, exactly as
 * the headband's does across a reconnect.
 */
function* emulator(seed: number): Generator<Frame> {
  const noises = CHANNELS.map((_, i) => rng(seed + i * 7919));
  const fault = rng(seed * 31 + 5);
  const total = SESSION_SECONDS * FS;
  let seq = 0;
  for (let start = 0; start + CHUNK <= total; start += CHUNK) {
    seq += 1;
    const t0 = start / FS;
    if (inSpan(t0, DROPOUTS)) continue; // link is down

    const corrupt = fault() < CORRUPT_RATE;
    const len = corrupt && fault() < 0.3 ? Math.max(1, Math.floor(CHUNK * fault())) : CHUNK;
    const samples = CHANNELS.map((_, ci) => {
      const out = new Float64Array(len);
      for (let i = 0; i < len; i += 1) {
        let v = emulatedSample((start + i) / FS, ci, noises[ci]!);
        if (corrupt) {
          const mode = fault();
          if (mode < 0.25) v = Number.NaN;
          else if (mode < 0.4) v = Number.POSITIVE_INFINITY;
          else if (mode < 0.55) v = Number.NEGATIVE_INFINITY;
          else if (mode < 0.8) v = 5000 * (fault() - 0.5);
        }
        out[i] = v;
      }
      return out;
    });
    yield { seq, t: t0, samples, corrupt };
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

interface Column {
  /** Case time of the column, seconds. */
  t: number;
  /** Milliseconds from the last ingested frame to the finished column. */
  latencyMs: number;
  /** Whole pipeline cost for this second (queue + work, all stages). */
  tickMs: number;
  /** Seconds since the link came back, or null outside a reconnect burst. */
  sinceReconnect: number | null;
}

interface Run {
  epochs: Epoch[];
  events: DetectedEvent[];
  columns: Column[];
  frameTimes: number[];
  frames: number;
  corruptFrames: number;
  /** Notifications the link never delivered. */
  droppedFrames: number;
  profiler: PipelineProfiler;
  analysedSeconds: number;
  suppressionSeconds: number;
  excludedGapSeconds: number;
  finite: boolean;
}

function replay(seed = 4_242): Run {
  const buffers: Record<string, Buf> = {};
  for (const ch of CHANNELS) buffers[ch] = makeBuf();
  const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
  const profiler = new PipelineProfiler();

  const epochs: Epoch[] = [];
  const columns: Column[] = [];
  const frameTimes: number[] = [];
  let frames = 0;
  let corruptFrames = 0;
  let lastSeq = 0;
  let droppedFrames = 0;
  let finite = true;
  /** Wall time of the last delivered frame, for ingestion-to-column latency. */
  let lastFrameEnd = 0;
  /** Next whole second of case time at which a column is due. */
  let nextTick = EPOCH_SECONDS;
  /** Case time at which the link most recently came back. */
  let lastReconnectAt: number | null = null;

  for (const frame of emulator(seed)) {
    droppedFrames += frame.seq - lastSeq - 1;
    if (frame.seq - lastSeq > 1) lastReconnectAt = frame.t;
    lastSeq = frame.seq;
    frames += 1;
    if (frame.corrupt) corruptFrames += 1;

    const ingestTicket = profiler.enqueue("ingest", frame.t);
    const frameStart = performance.now();
    profiler.run(ingestTicket, () => {
      CHANNELS.forEach((ch, ci) => {
        const buf = buffers[ch]!;
        const src = frame.samples[ci]!;
        for (let i = 0; i < src.length; i += 1) {
          buf.data[buf.write] = buf.filter.process(src[i]!);
          buf.write = (buf.write + 1) % BUFFER_LEN;
          if (buf.count < BUFFER_LEN) buf.count += 1;
        }
      });
    });
    lastFrameEnd = performance.now();
    frameTimes.push(lastFrameEnd - frameStart);

    // Columns are due on whole seconds of case time. A dropout delays the tick
    // to the first whole second after the link returns; the grid never slips
    // onto a fractional second.
    const frameEndTime = frame.t + frame.samples[0]!.length / FS;
    if (frameEndTime < nextTick) continue;
    const t = nextTick;
    while (nextTick <= frameEndTime) nextTick += HOP_SECONDS;

    const qualityTicket = profiler.enqueue("quality", t);
    const analyzeTicket = profiler.enqueue("analyze", t);

    profiler.run(qualityTicket, () => {
      for (const [a, b] of PAIRS) {
        const segA = readLast(buffers[a]!, FS * 2);
        const segB = readLast(buffers[b]!, FS * 2);
        const [psdA, psdB] = computePsdPair(segA, segB, FS);
        signalQuality(segA, psdA, FS);
        signalQuality(segB, psdB, FS);
      }
    });

    // Reference window: four-electrode average, as the monitor scores.
    const avg = new Float64Array(EPOCH_LEN);
    for (const ch of CHANNELS) {
      const seg = readLast(buffers[ch]!, EPOCH_LEN);
      for (let i = 0; i < EPOCH_LEN; i += 1) avg[i]! += seg[i]! / CHANNELS.length;
    }

    const epoch = profiler.run(analyzeTicket, () => analyzer.analyze(avg, t));
    const latencyMs = performance.now() - lastFrameEnd;

    if (
      !Number.isFinite(epoch.sef95) ||
      !Number.isFinite(epoch.suppressionRatio) ||
      !Number.isFinite(epoch.seizureScore) ||
      epoch.spectrum.some((v) => !Number.isFinite(v))
    ) {
      finite = false;
    }

    epochs.push(epoch);
    columns.push({
      t,
      latencyMs,
      tickMs: profiler.totalForTick(t),
      sinceReconnect:
        lastReconnectAt != null && t - lastReconnectAt <= 10 ? t - lastReconnectAt : null,
    });
  }

  return {
    epochs,
    events: [...analyzer.events],
    columns,
    frameTimes,
    frames,
    corruptFrames,
    droppedFrames,
    profiler,
    analysedSeconds: analyzer.analysedSeconds,
    suppressionSeconds: analyzer.suppressionSeconds,
    excludedGapSeconds: analyzer.excludedGapSeconds,
    finite,
  };
}

const run = replay();
const LATENCIES = run.columns.map((c) => c.latencyMs);
const DROPOUT_SECONDS = DROPOUTS.reduce((a, d) => a + (d.end - d.start), 0);

describe("five-minute dropout session: latency", () => {
  it("replays the whole session with real dropouts, reconnects and corrupt frames", () => {
    expect(run.frames).toBeGreaterThan(5_000);
    expect(run.droppedFrames).toBeGreaterThan((DROPOUT_SECONDS * FS) / CHUNK - 10);
    expect(run.corruptFrames).toBeGreaterThan(20);
    // Every second of link-up time produced its column; the dropouts did not.
    expect(run.columns.length).toBeGreaterThan(SESSION_SECONDS - DROPOUT_SECONDS - 20);
    expect(run.columns.length).toBeLessThanOrEqual(SESSION_SECONDS);
    expect(run.finite).toBe(true);
  }, TIMEOUT);

  it("keeps ingestion-to-DSA latency inside budget for every column", () => {
    expect(Math.max(...LATENCIES)).toBeLessThan(COLUMN_BUDGET.max);
    expect(quantile(LATENCIES, 0.95)).toBeLessThan(COLUMN_BUDGET.p95);
    expect(median(LATENCIES)).toBeLessThan(COLUMN_BUDGET.median);

    // Per-frame ingest cost, and the whole pipeline for one second of signal.
    expect(Math.max(...run.frameTimes)).toBeLessThan(FRAME_BUDGET_MS);
    expect(Math.max(...run.columns.map((c) => c.tickMs))).toBeLessThan(TICK_BUDGET_MS);
    for (const [stage, budget] of Object.entries({
      ingest: { p95: 40, max: 120 },
      quality: { p95: 60, max: 200 },
      analyze: { p95: 120, max: 300 },
    })) {
      const s = run.profiler.stats(stage);
      expect(s.p95Ms, `${stage} p95`).toBeLessThan(budget.p95);
      expect(s.maxMs, `${stage} max`).toBeLessThan(budget.max);
    }
  }, TIMEOUT);

  it("stays inside budget in the seconds immediately after each reconnect", () => {
    const afterReconnect = run.columns.filter((c) => c.sinceReconnect != null);
    // Each of the four reconnects contributes its own burst of columns.
    expect(afterReconnect.length).toBeGreaterThan(DROPOUTS.length * 3);
    const worst = Math.max(...afterReconnect.map((c) => c.latencyMs));
    expect(worst, "column latency after a reconnect").toBeLessThan(RECONNECT_BUDGET_MS);

    // A reconnect must not cost materially more than steady-state running.
    const steady = run.columns.filter((c) => c.sinceReconnect == null).map((c) => c.latencyMs);
    expect(median(afterReconnect.map((c) => c.latencyMs))).toBeLessThan(
      Math.max(median(steady) * 3, 20),
    );
  }, TIMEOUT);

  it("does not drift upward over the five minutes", () => {
    // Per-minute medians stay flat.
    const perMinute: number[] = [];
    for (let m = 0; m < SESSION_SECONDS / 60; m += 1) {
      const slice = run.columns
        .filter((c) => c.t >= m * 60 && c.t < (m + 1) * 60)
        .map((c) => c.latencyMs);
      if (slice.length > 5) perMinute.push(median(slice));
    }
    expect(perMinute.length).toBeGreaterThanOrEqual(4);
    const early = perMinute[0]!;
    for (const [i, m] of perMinute.entries()) {
      expect(m, `minute ${i} median latency`).toBeLessThan(Math.max(early * 3, 20));
    }

    // Least-squares creep against case minutes is negligible.
    expect(
      Math.abs(slope(run.columns.map((c) => c.t / 60), LATENCIES)),
    ).toBeLessThan(DRIFT_SLOPE_MS_PER_MINUTE);

    // And no stage builds a queue or degrades as history accumulates.
    for (const stage of run.profiler.stages()) {
      const stability = run.profiler.stability(stage);
      expect(stability.degrading, `${stage} degrading`).toBe(false);
      expect(stability.slopeMsPerMinute, `${stage} slope`).toBeLessThan(
        DRIFT_SLOPE_MS_PER_MINUTE,
      );
      expect(run.profiler.stats(stage).p95QueueMs, `${stage} queue`).toBeLessThan(200);
    }
  }, TIMEOUT);
});

describe("five-minute dropout session: one-second grid alignment", () => {
  it("places every DSA column on a whole second, in order", () => {
    for (const e of run.epochs) {
      expect(onGrid(e.t), `column at t=${e.t} off the one-second grid`).toBe(true);
    }
    for (let i = 1; i < run.epochs.length; i += 1) {
      const step = run.epochs[i]!.t - run.epochs[i - 1]!.t;
      expect(step, `column ${i} stepped backwards`).toBeGreaterThan(0);
      expect(onGrid(step), `column ${i} stepped by ${step} s`).toBe(true);
      expect(run.epochs[i]!.spectrum.length).toBe(run.epochs[0]!.spectrum.length);
    }
    // Dropouts show up as whole-second gaps in the grid, nothing else.
    const gaps = run.epochs
      .slice(1)
      .map((e, i) => ({ from: run.epochs[i]!.t, step: e.t - run.epochs[i]!.t }))
      .filter((g) => g.step > HOP_SECONDS);
    expect(gaps.length).toBe(DROPOUTS.length);
    for (const g of gaps) {
      expect(onGrid(g.step)).toBe(true);
      expect(
        DROPOUTS.some((d) => Math.abs(d.start - g.from) <= EPOCH_SECONDS + 1),
        `unexplained grid gap after t=${g.from}`,
      ).toBe(true);
    }
  }, TIMEOUT);

  it("reports seizure onsets and durations on the grid, inside the ictal spans", () => {
    const seizures = run.events.filter((e) => e.kind === "seizure");
    expect(seizures.length).toBeGreaterThan(0);
    for (const e of seizures) {
      expect(onGrid(e.t), `seizure onset t=${e.t} off grid`).toBe(true);
      expect(onGrid(e.duration), `seizure duration ${e.duration} s off grid`).toBe(true);
      expect(e.duration).toBeGreaterThan(0);
      expect(
        ICTAL.some(
          (s) =>
            e.t >= s.start - EDGE_TOLERANCE && e.t <= s.end + EDGE_LATENCY + EDGE_TOLERANCE,
        ),
        `seizure event at t=${e.t} outside every ictal span`,
      ).toBe(true);
      // A dropout mid-episode closes it at the last good sample: the reported
      // episode may be shorter than the label, never longer.
      const span = ICTAL.find((s) => e.t >= s.start - EDGE_TOLERANCE)!;
      expect(e.duration).toBeLessThanOrEqual(span.end - span.start + EDGE_TOLERANCE);
    }

    // Both scripted runs are recognised despite the interruptions.
    for (const [i, s] of ICTAL.entries()) {
      const found = seizures.some(
        (e) => e.t + e.duration > s.start && e.t < s.end + EDGE_LATENCY + EDGE_TOLERANCE,
      );
      expect(found, `ictal run ${i} missed entirely`).toBe(true);
    }

    // Alerting epochs are on the grid and confined to the ictal spans.
    const alerts = run.epochs.filter((e) => e.seizureAlert).map((e) => e.t);
    expect(alerts.length).toBeGreaterThan(0);
    for (const t of alerts) {
      expect(onGrid(t)).toBe(true);
      expect(
        ICTAL.some((s) => t >= s.start && t <= s.end + EDGE_LATENCY + EDGE_TOLERANCE),
        `seizure alert at t=${t} outside the ictal spans`,
      ).toBe(true);
    }
  }, TIMEOUT);

  it("keeps suppression episodes and the suppression clock on the grid", () => {
    const supp = run.events.filter(
      (e) => e.kind === "burst_suppression" || e.kind === "isoelectric",
    );
    expect(supp.length).toBeGreaterThan(0);
    for (const e of supp) {
      expect(onGrid(e.t), `suppression onset t=${e.t} off grid`).toBe(true);
      expect(onGrid(e.duration), `suppression duration ${e.duration} s off grid`).toBe(true);
      expect(e.t + e.duration).toBeLessThanOrEqual(
        SUPPRESSION.end + EDGE_LATENCY + EDGE_TOLERANCE,
      );
      expect(e.t).toBeGreaterThanOrEqual(SUPPRESSION.start - EDGE_TOLERANCE);
    }

    // Suppressed columns are whole seconds inside the labelled episode.
    const suppressed = run.epochs.filter((e) => e.isSuppressed).map((e) => e.t);
    expect(suppressed.length).toBeGreaterThan(10);
    for (const t of suppressed) expect(onGrid(t)).toBe(true);
    expect(Math.min(...suppressed)).toBeGreaterThanOrEqual(SUPPRESSION.start);
    expect(Math.max(...suppressed)).toBeLessThanOrEqual(
      SUPPRESSION.end + EDGE_LATENCY + EDGE_TOLERANCE,
    );

    // The clock counts whole analysed seconds, never the dropouts, and never
    // more suppression than there were analysed seconds.
    expect(onGrid(run.analysedSeconds)).toBe(true);
    expect(run.suppressionSeconds).toBeLessThanOrEqual(run.analysedSeconds);
    expect(run.suppressionSeconds).toBeLessThan(SUPPRESSION.end - SUPPRESSION.start + 5);
    expect(run.excludedGapSeconds).toBeGreaterThan(DROPOUT_SECONDS - DROPOUTS.length * 2);
    expect(run.analysedSeconds).toBeLessThanOrEqual(SESSION_SECONDS - DROPOUT_SECONDS + 5);
  }, TIMEOUT);

  it("is deterministic: the same emulator seed gives the same grid", () => {
    const again = replay();
    expect(again.epochs.map((e) => e.t)).toEqual(run.epochs.map((e) => e.t));
    expect(again.events.map((e) => [e.kind, e.t, e.duration])).toEqual(
      run.events.map((e) => [e.kind, e.t, e.duration]),
    );
    expect(again.suppressionSeconds).toBe(run.suppressionSeconds);
  }, TIMEOUT);
});
