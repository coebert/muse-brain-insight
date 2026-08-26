/**
 * End-to-end: burst-suppression episode onsets and offsets against labels.
 *
 * Builds recordings whose suppressed episodes have exactly known start and
 * end times (laid out on the detector's 0.5 s segment grid), replays them
 * through the real analyzer one second at a time, and compares the emitted
 * `burst_suppression` / `isoelectric` events with the ground-truth episodes:
 *   - every labelled episode is detected exactly once, in order,
 *   - onset and offset land within the unavoidable half-window latency,
 *   - reported durations match the labelled durations,
 *   - short (< 5 s) episodes are deliberately not reported, and
 *   - suppression ratio and suppression time agree with the same labels.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  EPOCH_SECONDS,
  HOP_SECONDS,
  EegAnalyzer,
  type DetectedEvent,
} from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";

const FS = MUSE_SAMPLE_RATE;
const SEG_SECONDS = 0.5;
const EPOCH_SAMPLES = EPOCH_SECONDS * FS;
/**
 * The detector calls an epoch suppressed once half of its 4 s window is
 * suppressed, so an episode is recognised ~2 s after it truly starts and
 * released ~2 s after it truly ends. Both edges carry the same latency, which
 * is why durations stay accurate.
 */
const EDGE_LATENCY = EPOCH_SECONDS / 2;
/** Allowed error on each edge, on top of the expected latency. */
const EDGE_TOLERANCE = 1.5;

interface Episode {
  start: number;
  end: number;
}

function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff - 0.5;
  };
}

interface Recording {
  label: string;
  signal: Float64Array;
  segments: boolean[];
  episodes: Episode[];
  seconds: number;
}

/** Builds a bursting trace interrupted by the labelled suppressed episodes. */
function makeRecording(
  label: string,
  seconds: number,
  episodes: Episode[],
  seed = 23,
  suppressedAmplitude = 1,
): Recording {
  const segCount = Math.round(seconds / SEG_SECONDS);
  const segSamples = Math.round(FS * SEG_SECONDS);
  const signal = new Float64Array(seconds * FS);
  const segments: boolean[] = [];
  const rnd = noise(seed);
  for (let s = 0; s < segCount; s += 1) {
    const segStart = s * SEG_SECONDS;
    const suppressed = episodes.some((e) => segStart >= e.start && segStart < e.end);
    segments.push(suppressed);
    for (let i = 0; i < segSamples; i += 1) {
      const idx = s * segSamples + i;
      const t = idx / FS;
      signal[idx] = suppressed
        ? suppressedAmplitude * rnd() // ≈2 µV p-p, far below the 8 µV threshold
        : 45 * Math.sin(2 * Math.PI * 10 * t) + 18 * Math.sin(2 * Math.PI * 2 * t) + 4 * rnd();
    }
  }
  return { label, signal, segments, episodes, seconds };
}

interface Replayed {
  events: DetectedEvent[];
  suppressionSeconds: number;
  truthSuppressionSeconds: number;
  ratios: { t: number; sr: number }[];
  truthRatios: { t: number; sr: number }[];
}

function replay(rec: Recording): Replayed {
  const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
  const segsPerEpoch = EPOCH_SECONDS / SEG_SECONDS;
  const epochFractions: { t: number; fraction: number }[] = [];
  const ratios: { t: number; sr: number }[] = [];
  const truthRatios: { t: number; sr: number }[] = [];

  for (let start = 0; start + EPOCH_SAMPLES <= rec.signal.length; start += FS * HOP_SECONDS) {
    const t = (start + EPOCH_SAMPLES) / FS;
    const epoch = analyzer.analyze(
      Float64Array.from(rec.signal.subarray(start, start + EPOCH_SAMPLES)),
      t,
    );
    ratios.push({ t, sr: epoch.suppressionRatio });

    const firstSeg = Math.round(start / FS / SEG_SECONDS);
    let suppressed = 0;
    for (let s = firstSeg; s < firstSeg + segsPerEpoch; s += 1) if (rec.segments[s]) suppressed += 1;
    epochFractions.push({ t, fraction: suppressed / segsPerEpoch });

    const cutoff = t - DEFAULT_SETTINGS.srWindowSeconds;
    const window = epochFractions.filter((e) => e.t >= cutoff);
    truthRatios.push({
      t,
      sr: (window.reduce((a, b) => a + b.fraction, 0) / window.length) * 100,
    });
  }

  return {
    events: analyzer.events.filter(
      (e) => e.kind === "burst_suppression" || e.kind === "isoelectric",
    ),
    suppressionSeconds: analyzer.suppressionSeconds,
    truthSuppressionSeconds: epochFractions.reduce((a, b) => a + b.fraction, 0) * HOP_SECONDS,
    ratios,
    truthRatios,
  };
}

/** Episodes long enough for the detector to report (>= 5 s sustained). */
const reportable = (episodes: Episode[]) => episodes.filter((e) => e.end - e.start >= 7);

describe("burst-suppression onsets and offsets versus labelled ground truth", () => {
  const TIMEOUT = 60_000;

  const CASES: Array<{ name: string; seconds: number; episodes: Episode[] }> = [
    {
      name: "one long episode",
      seconds: 180,
      episodes: [{ start: 60, end: 105 }],
    },
    {
      name: "three separated episodes",
      seconds: 300,
      episodes: [
        { start: 30, end: 60 },
        { start: 120, end: 150 },
        { start: 220, end: 265 },
      ],
    },
    {
      name: "episodes of mixed length",
      seconds: 300,
      episodes: [
        { start: 20, end: 32 },
        { start: 80, end: 170 },
        { start: 220, end: 240.5 },
      ],
    },
  ];

  it.each(CASES)(
    "detects $name with correct onset, offset and duration",
    ({ name, seconds, episodes }) => {
      const rec = makeRecording(name, seconds, episodes);
      const { events } = replay(rec);
      const truth = reportable(episodes);

      expect(events.length, `event count for ${name}`).toBe(truth.length);

      events.forEach((ev, i) => {
        const gt = truth[i]!;
        const onsetError = ev.t - (gt.start + EDGE_LATENCY);
        const offsetError = ev.t + ev.duration - (gt.end + EDGE_LATENCY);
        expect(Math.abs(onsetError), `onset error, episode ${i} of ${name}`).toBeLessThanOrEqual(
          EDGE_TOLERANCE,
        );
        expect(Math.abs(offsetError), `offset error, episode ${i} of ${name}`).toBeLessThanOrEqual(
          EDGE_TOLERANCE,
        );
        expect(
          Math.abs(ev.duration - (gt.end - gt.start)),
          `duration error, episode ${i} of ${name}`,
        ).toBeLessThanOrEqual(EDGE_TOLERANCE);
        // Episodes never overlap or run backwards.
        if (i > 0) expect(ev.t).toBeGreaterThan(events[i - 1]!.t + events[i - 1]!.duration);
      });
    },
    TIMEOUT,
  );

  it("matches suppression ratio and suppression time to the same labels", () => {
    const episodes = CASES[1]!.episodes;
    const rec = makeRecording("ratio cross-check", CASES[1]!.seconds, episodes);
    const { ratios, truthRatios, suppressionSeconds, truthSuppressionSeconds } = replay(rec);

    for (const point of ratios) {
      const truth = truthRatios.find((r) => r.t === point.t)!.sr;
      expect(Math.abs(point.sr - truth), `SR at t=${point.t}s`).toBeLessThan(1.5);
    }

    expect(suppressionSeconds).toBeCloseTo(truthSuppressionSeconds, 0);
    const labelledSeconds = episodes.reduce((a, e) => a + (e.end - e.start), 0);
    expect(Math.abs(suppressionSeconds - labelledSeconds)).toBeLessThan(1.5);
  }, TIMEOUT);

  it("reports nothing on a continuously bursting recording", () => {
    const rec = makeRecording("no suppression", 180, []);
    const { events, suppressionSeconds, ratios } = replay(rec);
    expect(events).toHaveLength(0);
    expect(suppressionSeconds).toBeLessThan(1);
    expect(Math.max(...ratios.map((r) => r.sr))).toBeLessThan(2);
  }, TIMEOUT);

  it("does not report sub-5 s suppression blips but still counts their time", () => {
    const blips: Episode[] = [
      { start: 40, end: 43 },
      { start: 80, end: 83.5 },
      { start: 130, end: 132 },
    ];
    const rec = makeRecording("blips", 180, blips);
    const { events, suppressionSeconds } = replay(rec);
    expect(events).toHaveLength(0);
    const labelled = blips.reduce((a, e) => a + (e.end - e.start), 0);
    expect(Math.abs(suppressionSeconds - labelled)).toBeLessThan(1.5);
  }, TIMEOUT);

  it("labels a fully isoelectric episode as isoelectric, not burst suppression", () => {
    const rec = makeRecording("isoelectric", 180, [{ start: 60, end: 120 }]);
    const { events } = replay(rec);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("critical");
    expect(Math.abs(events[0]!.duration - 60)).toBeLessThanOrEqual(EDGE_TOLERANCE);
  }, TIMEOUT);
});
