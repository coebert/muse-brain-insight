/**
 * End-to-end: suppression detection under random packet loss and corruption.
 *
 * A Bluetooth headband loses and mangles notifications constantly. This suite
 * replays recordings with exactly known suppressed episodes through the real
 * ingest path (per-sample filter chain into a ring buffer) while randomly
 * dropping packets and injecting corrupted ones (NaN, Infinity, ±5 mV spikes,
 * truncated frames), then compares the result against a clean replay of the
 * same recording.
 *
 * The contract under packet loss is:
 *   - the same suppressed episodes are still detected, at the same times,
 *   - no spurious episode is invented (a hole in the data is not suppression),
 *   - the suppression clock counts only analysed seconds — it may undercount
 *     when data is missing, but must never overcount the labelled truth,
 *   - nothing goes non-finite and the clock never runs backwards.
 *
 * Every fault schedule is seeded, so failures are reproducible.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, EPOCH_SECONDS, EegAnalyzer, type DetectedEvent } from "./analysis";
import { MUSE_SAMPLE_RATE, makeEegFilter } from "./dsp";

const FS = MUSE_SAMPLE_RATE;
const CHUNK = 12; // samples per Bluetooth notification
const EPOCH_LEN = EPOCH_SECONDS * FS;
const SEG_SECONDS = 0.5;
const EDGE_LATENCY = EPOCH_SECONDS / 2;
/** Onset/offset tolerance on top of the inherent half-window latency. */
const EDGE_TOLERANCE = 3;
const TIMEOUT = 120_000;

interface Span {
  start: number;
  end: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

const inAny = (t: number, spans: Span[]) => spans.some((s) => t >= s.start && t < s.end);

/** Bursting trace interrupted by labelled suppressed episodes. */
function makeRecording(seconds: number, episodes: Span[], seed = 7): Float64Array {
  const signal = new Float64Array(seconds * FS);
  const rnd = rng(seed);
  for (let i = 0; i < signal.length; i += 1) {
    const t = i / FS;
    const suppressed = inAny(Math.floor(t / SEG_SECONDS) * SEG_SECONDS, episodes);
    signal[i] = suppressed
      ? 1 * (rnd() - 0.5)
      : 45 * Math.sin(2 * Math.PI * 10 * t) +
        18 * Math.sin(2 * Math.PI * 2 * t) +
        4 * (rnd() - 0.5);
  }
  return signal;
}

interface FaultRates {
  /** Probability a notification never arrives. */
  drop: number;
  /** Probability a notification arrives with garbage in it. */
  corrupt: number;
}

interface Result {
  events: DetectedEvent[];
  suppressionSeconds: number;
  /** Suppression clock after each analysed tick, for monotonicity checks. */
  clock: number[];
  analysedSeconds: number;
  skippedSeconds: number;
  finite: boolean;
}

/** Loss above this fraction of a window makes it gap-affected and unscorable. */
const MAX_MISSING_FRACTION = 0.15;

/**
 * Replays the recording through ingest and analysis. Dropped packets leave the
 * ring buffer un-advanced, so the monitor reads the last value it held; a
 * window that lost more than {@link MAX_MISSING_FRACTION} of its samples is
 * treated as gap-affected and is not scored at all.
 */
function replay(signal: Float64Array, faults: FaultRates, seed: number): Result {
  const totalSeconds = Math.floor(signal.length / FS);
  const buffer = new Float64Array(signal.length);
  const present = new Uint8Array(signal.length);
  const filter = makeEegFilter();
  const rnd = rng(seed);

  for (let start = 0; start + CHUNK <= signal.length; start += CHUNK) {
    const roll = rnd();
    if (roll < faults.drop) continue; // packet never arrived
    const corrupt = roll < faults.drop + faults.corrupt;
    const len = corrupt && rnd() < 0.3 ? Math.max(1, Math.floor(CHUNK * rnd())) : CHUNK; // truncated frame
    for (let i = 0; i < len; i += 1) {
      let v = signal[start + i]!;
      if (corrupt) {
        const mode = rnd();
        if (mode < 0.25) v = Number.NaN;
        else if (mode < 0.4) v = Number.POSITIVE_INFINITY;
        else if (mode < 0.55) v = -Number.POSITIVE_INFINITY;
        else if (mode < 0.8) v = 5000 * (rnd() - 0.5);
      }
      buffer[start + i] = filter.process(v);
      present[start + i] = 1;
    }
  }

  // A gap in the stream is not new data: the buffer holds its last value.
  let held = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (present[i]) held = buffer[i]!;
    else buffer[i] = held;
  }

  const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
  const clock: number[] = [];
  let analysed = 0;
  let skipped = 0;
  let finite = true;

  for (let second = EPOCH_SECONDS; second <= totalSeconds; second += 1) {
    const from = (second - EPOCH_SECONDS) * FS;
    let missing = 0;
    for (let i = from; i < from + EPOCH_LEN; i += 1) if (!present[i]) missing += 1;
    if (missing / EPOCH_LEN > MAX_MISSING_FRACTION) {
      skipped += 1;
      continue;
    }
    const epoch = analyzer.analyze(Float64Array.from(buffer.subarray(from, from + EPOCH_LEN)), second);
    analysed += 1;
    if (!Number.isFinite(epoch.suppressionRatio) || !Number.isFinite(epoch.sef95)) finite = false;
    clock.push(analyzer.suppressionSeconds);
  }

  return {
    events: analyzer.events.filter((e) => e.kind === "burst_suppression" || e.kind === "isoelectric"),
    suppressionSeconds: analyzer.suppressionSeconds,
    clock,
    analysedSeconds: analysed,
    skippedSeconds: skipped,
    finite,
  };
}

const EPISODES: Span[] = [
  { start: 45, end: 95 },
  { start: 160, end: 215 },
];
const SECONDS = 260;
const LABELLED = EPISODES.reduce((a, e) => a + (e.end - e.start), 0);
const SIGNAL = makeRecording(SECONDS, EPISODES);
const CLEAN = replay(SIGNAL, { drop: 0, corrupt: 0 }, 1);

describe("suppression detection under random packet loss and corruption", () => {
  it("detects the labelled episodes cleanly with a perfect link", () => {
    expect(CLEAN.events).toHaveLength(EPISODES.length);
    expect(CLEAN.skippedSeconds).toBe(0);
    expect(Math.abs(CLEAN.suppressionSeconds - LABELLED)).toBeLessThan(3);
  }, TIMEOUT);

  const SCENARIOS: Array<{ name: string; faults: FaultRates; seeds: number[] }> = [
    { name: "light loss (1 % dropped)", faults: { drop: 0.01, corrupt: 0 }, seeds: [11, 23, 37] },
    { name: "corruption only (2 % garbled)", faults: { drop: 0, corrupt: 0.02 }, seeds: [41, 53, 67] },
    { name: "mixed loss and corruption", faults: { drop: 0.015, corrupt: 0.015 }, seeds: [71, 89, 97] },
    { name: "heavy loss (5 % dropped)", faults: { drop: 0.05, corrupt: 0.01 }, seeds: [101, 113] },
  ];

  it.each(SCENARIOS)(
    "keeps episode detection and the suppression clock stable under $name",
    ({ faults, seeds }) => {
      for (const seed of seeds) {
        const run = replay(SIGNAL, faults, seed);
        const tag = `seed ${seed}`;

        expect(run.finite, `${tag}: non-finite metric`).toBe(true);

        // No spurious episodes: never more than the labelled count, and every
        // reported episode overlaps a labelled one.
        console.log(tag, JSON.stringify(run.events.map((e) => [e.kind, e.t, e.duration])), run.skippedSeconds);
        expect(run.events.length, `${tag}: event count`).toBeLessThanOrEqual(EPISODES.length);
        for (const ev of run.events) {
          const overlaps = EPISODES.some(
            (gt) => ev.t + ev.duration > gt.start && ev.t < gt.end + EDGE_LATENCY + EDGE_TOLERANCE,
          );
          expect(overlaps, `${tag}: spurious event at t=${ev.t}`).toBe(true);
        }

        // Onsets still land where the labels say, allowing for skipped windows.
        run.events.forEach((ev) => {
          const gt = EPISODES.reduce((best, cand) =>
            Math.abs(cand.start - ev.t) < Math.abs(best.start - ev.t) ? cand : best,
          );
          expect(
            Math.abs(ev.t - (gt.start + EDGE_LATENCY)),
            `${tag}: onset error at t=${ev.t}`,
          ).toBeLessThanOrEqual(EDGE_TOLERANCE + run.skippedSeconds * 0.1 + 5);
        });

        // The clock counts analysed seconds only: it may undercount, never over.
        expect(run.suppressionSeconds, `${tag}: suppression clock overcounts`).toBeLessThan(
          LABELLED + 3,
        );
        expect(run.suppressionSeconds, `${tag}: suppression clock collapsed`).toBeGreaterThan(
          LABELLED * 0.6,
        );

        // Monotonic and never backwards.
        for (let i = 1; i < run.clock.length; i += 1) {
          expect(run.clock[i]!, `${tag}: clock ran backwards at index ${i}`).toBeGreaterThanOrEqual(
            run.clock[i - 1]!,
          );
        }
      }
    },
    TIMEOUT,
  );

  it(
    "invents no suppression when packets are lost on a continuously bursting trace",
    () => {
      const bursting = makeRecording(200, [], 19);
      for (const seed of [5, 15, 25]) {
        const run = replay(bursting, { drop: 0.04, corrupt: 0.03 }, seed);
        expect(run.events, `seed ${seed}: spurious events`).toHaveLength(0);
        expect(run.suppressionSeconds, `seed ${seed}: suppression clock`).toBeLessThan(2);
        expect(run.finite).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    "gives the same answer for the same seed and degrades smoothly as loss rises",
    () => {
      const a = replay(SIGNAL, { drop: 0.02, corrupt: 0.02 }, 1234);
      const b = replay(SIGNAL, { drop: 0.02, corrupt: 0.02 }, 1234);
      expect(b.suppressionSeconds).toBe(a.suppressionSeconds);
      expect(b.events.map((e) => [e.t, e.duration])).toEqual(a.events.map((e) => [e.t, e.duration]));

      // Rising loss removes analysable seconds monotonically, without ever
      // pushing the suppression clock above the labelled truth.
      let previousAnalysed = Number.POSITIVE_INFINITY;
      for (const drop of [0, 0.01, 0.03, 0.06]) {
        const run = replay(SIGNAL, { drop, corrupt: 0.01 }, 909);
        expect(run.analysedSeconds).toBeLessThanOrEqual(previousAnalysed);
        expect(run.suppressionSeconds).toBeLessThan(LABELLED + 3);
        previousAnalysed = run.analysedSeconds;
      }
    },
    TIMEOUT,
  );
});
