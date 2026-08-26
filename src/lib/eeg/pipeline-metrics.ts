/**
 * Per-stage pipeline instrumentation.
 *
 * The monitor processes every second of EEG through a short pipeline —
 * ingest/filter, signal quality, spectral analysis, render — and each stage
 * can queue behind the previous one. This module records, per stage:
 *
 *  - `queueMs`: how long the work waited between being handed to the stage and
 *    actually starting (the backlog signal),
 *  - `workMs`: how long the stage itself took.
 *
 * It also answers the question that matters clinically: are the timings
 * *stable* over a long case, or are they creeping up as history accumulates?
 */

export interface StageSample {
  /** Analyzer time (seconds into the case) this work belongs to. */
  t: number;
  /** Wait between hand-off and start, in milliseconds. */
  queueMs: number;
  /** Time spent inside the stage, in milliseconds. */
  workMs: number;
}

export interface StageStats {
  stage: string;
  count: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  meanQueueMs: number;
  p95QueueMs: number;
  maxQueueMs: number;
  /** Sum of queue + work across every sample, in milliseconds. */
  totalMs: number;
}

export interface StageStability {
  stage: string;
  /** Median total (queue + work) over the first half of the session. */
  firstHalfMedianMs: number;
  /** Median total over the second half. */
  secondHalfMedianMs: number;
  /** secondHalf / firstHalf; 1 means perfectly flat. */
  ratio: number;
  /** Least-squares trend of total time against analyzer minutes. */
  slopeMsPerMinute: number;
  /** True when the later half is materially slower than the earlier half. */
  degrading: boolean;
}

const quantile = (sorted: number[], q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

const median = (sorted: number[]): number => quantile(sorted, 0.5);

/** Handle returned by {@link PipelineProfiler.enqueue}. */
export interface StageTicket {
  stage: string;
  t: number;
  enqueuedAt: number;
}

export interface ProfilerOptions {
  /** Clock injection point; defaults to `performance.now`. */
  now?: () => number;
  /** Cap on retained samples per stage (oldest dropped). 0 keeps everything. */
  maxSamples?: number;
}

export class PipelineProfiler {
  private readonly samples = new Map<string, StageSample[]>();
  private readonly now: () => number;
  private readonly maxSamples: number;

  constructor(options: ProfilerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.maxSamples = options.maxSamples ?? 0;
  }

  /** Mark work as handed to a stage; queue time accrues from this moment. */
  enqueue(stage: string, t: number): StageTicket {
    return { stage, t, enqueuedAt: this.now() };
  }

  /** Run `fn` as the stage's work, recording queue wait and work time. */
  run<T>(ticket: StageTicket, fn: () => T): T {
    const started = this.now();
    try {
      return fn();
    } finally {
      const ended = this.now();
      this.record(ticket.stage, {
        t: ticket.t,
        queueMs: Math.max(0, started - ticket.enqueuedAt),
        workMs: Math.max(0, ended - started),
      });
    }
  }

  /** Convenience for stages with no queueing: measure work only. */
  measure<T>(stage: string, t: number, fn: () => T): T {
    return this.run(this.enqueue(stage, t), fn);
  }

  record(stage: string, sample: StageSample): void {
    const list = this.samples.get(stage) ?? [];
    list.push(sample);
    if (this.maxSamples > 0 && list.length > this.maxSamples) list.shift();
    this.samples.set(stage, list);
  }

  stages(): string[] {
    return [...this.samples.keys()];
  }

  samplesFor(stage: string): StageSample[] {
    return [...(this.samples.get(stage) ?? [])];
  }

  stats(stage: string): StageStats {
    const list = this.samples.get(stage) ?? [];
    const work = [...list.map((s) => s.workMs)].sort((a, b) => a - b);
    const queue = [...list.map((s) => s.queueMs)].sort((a, b) => a - b);
    const totalMs = list.reduce((acc, s) => acc + s.workMs + s.queueMs, 0);
    const sum = work.reduce((a, b) => a + b, 0);
    return {
      stage,
      count: list.length,
      meanMs: list.length ? sum / list.length : 0,
      medianMs: median(work),
      p95Ms: quantile(work, 0.95),
      maxMs: work.length ? work[work.length - 1]! : 0,
      meanQueueMs: list.length ? queue.reduce((a, b) => a + b, 0) / list.length : 0,
      p95QueueMs: quantile(queue, 0.95),
      maxQueueMs: queue.length ? queue[queue.length - 1]! : 0,
      totalMs,
    };
  }

  /** Total pipeline cost (all stages, queue + work) for one analyzer second. */
  totalForTick(t: number): number {
    let total = 0;
    for (const list of this.samples.values()) {
      for (const s of list) if (s.t === t) total += s.workMs + s.queueMs;
    }
    return total;
  }

  /**
   * Compare the first and second halves of the recorded samples for a stage.
   * `tolerance` is the allowed growth ratio (0.5 = up to 50 % slower) before a
   * stage counts as degrading; an absolute floor avoids flagging sub-millisecond
   * jitter on fast stages.
   */
  stability(stage: string, tolerance = 0.5, floorMs = 1): StageStability {
    const list = this.samples.get(stage) ?? [];
    const totals = list.map((s) => ({ t: s.t, ms: s.workMs + s.queueMs }));
    const mid = Math.floor(totals.length / 2);
    const first = totals.slice(0, mid).map((x) => x.ms).sort((a, b) => a - b);
    const second = totals.slice(mid).map((x) => x.ms).sort((a, b) => a - b);
    const firstHalfMedianMs = median(first);
    const secondHalfMedianMs = median(second);
    const ratio = firstHalfMedianMs > 0 ? secondHalfMedianMs / firstHalfMedianMs : 1;

    // Least-squares slope of total time against analyzer minutes.
    let slopeMsPerMinute = 0;
    if (totals.length > 2) {
      const xs = totals.map((x) => x.t / 60);
      const ys = totals.map((x) => x.ms);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0;
      let den = 0;
      for (let i = 0; i < xs.length; i += 1) {
        num += (xs[i]! - mx) * (ys[i]! - my);
        den += (xs[i]! - mx) ** 2;
      }
      slopeMsPerMinute = den > 0 ? num / den : 0;
    }

    const grew = secondHalfMedianMs - firstHalfMedianMs;
    return {
      stage,
      firstHalfMedianMs,
      secondHalfMedianMs,
      ratio,
      slopeMsPerMinute,
      degrading: grew > floorMs && ratio > 1 + tolerance,
    };
  }

  /** One row per stage, for logging or a diagnostics panel. */
  report(): Array<StageStats & { stability: StageStability }> {
    return this.stages().map((stage) => ({
      ...this.stats(stage),
      stability: this.stability(stage),
    }));
  }

  reset(): void {
    this.samples.clear();
  }
}
