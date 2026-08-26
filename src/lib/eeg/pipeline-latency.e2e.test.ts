/**
 * End-to-end: per-stage latency and queue time during continuous playback.
 *
 * Replays a Muse 2-shaped stream through the real pipeline — ingest/filter,
 * paired-FFT signal quality, spectral analysis — with every stage wrapped in
 * `PipelineProfiler`. Each stage is enqueued at the top of the analyzer tick
 * and run in order, so downstream stages accrue genuine queue time behind the
 * work in front of them, exactly as they do on the live monitor.
 *
 * The assertions are about *stability*: a long case must not get slower as
 * history accumulates, and no stage may build a queue.
 */
import { describe, expect, it } from "vitest";

import { EegAnalyzer, type Epoch } from "@/lib/eeg/analysis";
import { MUSE_SAMPLE_RATE, computePsdPair, makeEegFilter, signalQuality } from "@/lib/eeg/dsp";
import { PipelineProfiler } from "@/lib/eeg/pipeline-metrics";

const FS = MUSE_SAMPLE_RATE;
const CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;
const PAIRS: Array<[string, string]> = [
  ["TP9", "AF7"],
  ["AF8", "TP10"],
];
const CHUNK = 12;
const EPOCH_LEN = FS * 4;
const BUFFER_LEN = FS * 60;
/** Long enough for slow accumulation to show, short enough for CI. */
const SESSION_SECONDS = 6 * 60;

/** Agreed per-stage budgets for one analyzer second, in milliseconds. */
const BUDGET: Record<string, { p95: number; max: number }> = {
  ingest: { p95: 40, max: 120 },
  quality: { p95: 60, max: 200 },
  analyze: { p95: 120, max: 300 },
};
/** No stage may sit waiting behind the pipeline for long. */
const QUEUE_P95_MS = 200;
const QUEUE_MAX_MS = 500;
/** All stages together, per second of signal, must stay inside real time. */
const TICK_BUDGET_MS = 600;

interface Buf {
  data: Float64Array;
  write: number;
  filter: ReturnType<typeof makeEegFilter>;
}

const makeBuf = (): Buf => ({ data: new Float64Array(BUFFER_LEN), write: 0, filter: makeEegFilter() });

function readLast(buf: Buf, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = buf.data[(buf.write - n + i + BUFFER_LEN * 2) % BUFFER_LEN]!;
  }
  return out;
}

/** Deterministic anaesthesia-like EEG: delta + alpha spindles + noise. */
function sample(t: number, seed: { s: number }): number {
  seed.s = (seed.s * 1103515245 + 12345) % 2147483648;
  const noise = seed.s / 2147483648 - 0.5;
  return (
    26 * Math.sin(2 * Math.PI * 1.5 * t) +
    17 * Math.sin(2 * Math.PI * 10 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.07 * t)) +
    7 * noise
  );
}

interface Run {
  profiler: PipelineProfiler;
  epochs: Epoch[];
  tickTotals: Array<{ t: number; ms: number }>;
}

function replayInstrumented(): Run {
  const profiler = new PipelineProfiler();
  const buffers: Record<string, Buf> = {};
  for (const c of CHANNELS) buffers[c] = makeBuf();
  const analyzer = new EegAnalyzer(undefined, FS);
  const epochs: Epoch[] = [];
  const tickTotals: Array<{ t: number; ms: number }> = [];
  const seeds: Record<string, { s: number }> = {};
  CHANNELS.forEach((c, i) => (seeds[c] = { s: 1000 + i * 7919 }));

  for (let second = 1; second <= SESSION_SECONDS; second += 1) {
    const t = second;
    // All three stages are handed the tick at once; each accrues queue time
    // while the stages ahead of it are still working.
    const ingestTicket = profiler.enqueue("ingest", t);
    const qualityTicket = profiler.enqueue("quality", t);
    const analyzeTicket = profiler.enqueue("analyze", t);

    profiler.run(ingestTicket, () => {
      for (let offset = 0; offset < FS; offset += CHUNK) {
        for (const c of CHANNELS) {
          const buf = buffers[c]!;
          for (let i = 0; i < CHUNK; i += 1) {
            const time = (second - 1) + (offset + i) / FS;
            buf.data[buf.write % BUFFER_LEN] = buf.filter.process(sample(time, seeds[c]!));
            buf.write += 1;
          }
        }
      }
    });

    if (second * FS < EPOCH_LEN) continue;

    profiler.run(qualityTicket, () => {
      for (const [a, b] of PAIRS) {
        const [psdA, psdB] = computePsdPair(
          readLast(buffers[a]!, EPOCH_LEN),
          readLast(buffers[b]!, EPOCH_LEN),
          FS,
        );
        signalQuality(psdA, FS);
        signalQuality(psdB, FS);
      }
    });

    const epoch = profiler.run(analyzeTicket, () => analyzer.analyze(readLast(buffers['TP9']!, EPOCH_LEN), t));
    epochs.push(epoch);
    tickTotals.push({ t, ms: profiler.totalForTick(t) });
  }

  return { profiler, epochs, tickTotals };
}

const run = replayInstrumented();

const half = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe("per-stage pipeline instrumentation during playback", () => {
  it("produces a full session of epochs with every stage instrumented", () => {
    expect(run.epochs.length).toBeGreaterThan(SESSION_SECONDS - 10);
    expect(run.profiler.stages().sort()).toEqual(["analyze", "ingest", "quality"]);
    for (const stage of ["ingest", "quality", "analyze"]) {
      expect(run.profiler.stats(stage).count).toBeGreaterThan(SESSION_SECONDS - 10);
    }
  });

  it("keeps every stage inside its latency budget", () => {
    for (const [stage, budget] of Object.entries(BUDGET)) {
      const s = run.profiler.stats(stage);
      expect(`${stage} p95=${s.p95Ms.toFixed(1)}`).toBe(`${stage} p95=${s.p95Ms.toFixed(1)}`);
      expect(s.p95Ms).toBeLessThan(budget.p95);
      expect(s.maxMs).toBeLessThan(budget.max);
    }
  });

  it("never builds a queue behind the pipeline", () => {
    for (const stage of run.profiler.stages()) {
      const s = run.profiler.stats(stage);
      expect(s.p95QueueMs).toBeLessThan(QUEUE_P95_MS);
      expect(s.maxQueueMs).toBeLessThan(QUEUE_MAX_MS);
    }
    // Ingest runs first every tick, so it should essentially never wait.
    expect(run.profiler.stats("ingest").p95QueueMs).toBeLessThan(5);
  });

  it("completes all stages for one second of signal well inside real time", () => {
    const totals = run.tickTotals.map((x) => x.ms);
    expect(Math.max(...totals)).toBeLessThan(TICK_BUDGET_MS);
    expect(half(totals)).toBeLessThan(TICK_BUDGET_MS / 3);
  });

  it("reports stable, non-degrading timings across the minutes of the case", () => {
    for (const stage of run.profiler.stages()) {
      const stability = run.profiler.stability(stage);
      expect(stability.degrading).toBe(false);
      // Later minutes must not cost materially more than earlier ones.
      expect(stability.secondHalfMedianMs).toBeLessThan(stability.firstHalfMedianMs + 5);
      // And there must be no upward creep with time.
      expect(stability.slopeMsPerMinute).toBeLessThan(2);
    }
  });

  it("shows no growth in total tick cost between the first and last minute", () => {
    const firstMinute = run.tickTotals.filter((x) => x.t <= 60).map((x) => x.ms);
    const lastMinute = run.tickTotals.filter((x) => x.t > SESSION_SECONDS - 60).map((x) => x.ms);
    const early = half(firstMinute);
    const late = half(lastMinute);
    expect(late).toBeLessThan(early * 2 + 5);
  });
});

describe("PipelineProfiler instrumentation maths", () => {
  /** Deterministic clock so the statistics themselves can be asserted. */
  function fakeProfiler(): { profiler: PipelineProfiler; advance: (ms: number) => void } {
    let clock = 0;
    const profiler = new PipelineProfiler({ now: () => clock });
    return { profiler, advance: (ms) => (clock += ms) };
  }

  it("separates queue time from work time", () => {
    const { profiler, advance } = fakeProfiler();
    const ticket = profiler.enqueue("analyze", 1);
    advance(30); // waited behind another stage
    profiler.run(ticket, () => advance(20));
    const s = profiler.stats("analyze");
    expect(s.medianMs).toBe(20);
    expect(s.maxQueueMs).toBe(30);
    expect(s.totalMs).toBe(50);
    expect(profiler.totalForTick(1)).toBe(50);
  });

  it("flags a stage whose timings creep upward", () => {
    const { profiler, advance } = fakeProfiler();
    for (let t = 1; t <= 60; t += 1) profiler.run(profiler.enqueue("slow", t), () => advance(10 + t));
    const stability = profiler.stability("slow");
    expect(stability.degrading).toBe(true);
    expect(stability.slopeMsPerMinute).toBeGreaterThan(0);
  });

  it("accepts a stage whose timings stay flat", () => {
    const { profiler, advance } = fakeProfiler();
    for (let t = 1; t <= 60; t += 1) profiler.run(profiler.enqueue("flat", t), () => advance(t % 2 ? 8 : 9));
    const stability = profiler.stability("flat");
    expect(stability.degrading).toBe(false);
    expect(Math.abs(stability.slopeMsPerMinute)).toBeLessThan(1);
  });
});
