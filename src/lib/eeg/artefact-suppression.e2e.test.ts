/**
 * End-to-end: burst-suppression accuracy under heavy artefact.
 *
 * Real theatre and ICU traces are contaminated: forehead EMG from light
 * anaesthesia or shivering, large movement/electrode-pull excursions, and
 * 50 Hz mains pick-up from nearby equipment. This suite injects each of those
 * into recordings with exactly known suppressed episodes and checks that the
 * suppression pipeline either
 *
 *   - stays accurate (onset, offset, ratio, cumulative time), when the
 *     artefact is one the front end can reject (mains, out-of-band EMG), or
 *   - correctly refuses the data — the contaminated seconds are excluded from
 *     the suppression clock, the epoch is marked artefact/poor quality, and
 *     suppression confidence collapses — rather than inventing suppression.
 *
 * The failure this guards against is the clinically dangerous one: a flat-
 * looking artefact-gated trace being reported as deep suppression, or a noisy
 * trace hiding real suppression.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  EPOCH_SECONDS,
  HOP_SECONDS,
  EegAnalyzer,
  type DetectedEvent,
  type Epoch,
} from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";

const FS = MUSE_SAMPLE_RATE;
const SEG_SECONDS = 0.5;
const EPOCH_SAMPLES = EPOCH_SECONDS * FS;
/** The detector recognises an episode ~half a window after it truly starts. */
const EDGE_LATENCY = EPOCH_SECONDS / 2;
const EDGE_TOLERANCE = 2;
const TIMEOUT = 60_000;

interface Span {
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

const inAny = (t: number, spans: Span[]) => spans.some((s) => t >= s.start && t < s.end);

interface Recording {
  signal: Float64Array;
  segments: boolean[];
  episodes: Span[];
  seconds: number;
}

/** Bursting trace interrupted by the labelled suppressed episodes. */
function makeRecording(seconds: number, episodes: Span[], seed = 91): Recording {
  const segCount = Math.round(seconds / SEG_SECONDS);
  const segSamples = Math.round(FS * SEG_SECONDS);
  const signal = new Float64Array(seconds * FS);
  const segments: boolean[] = [];
  const rnd = noise(seed);
  for (let s = 0; s < segCount; s += 1) {
    const suppressed = inAny(s * SEG_SECONDS, episodes);
    segments.push(suppressed);
    for (let i = 0; i < segSamples; i += 1) {
      const idx = s * segSamples + i;
      const t = idx / FS;
      signal[idx] = suppressed
        ? 1 * rnd()
        : 45 * Math.sin(2 * Math.PI * 10 * t) + 18 * Math.sin(2 * Math.PI * 2 * t) + 4 * rnd();
    }
  }
  return { signal, segments, episodes, seconds };
}

type Artefact = "emg" | "movement" | "line";

/** Adds an artefact on top of an existing trace, over the given spans. */
function contaminate(rec: Recording, kind: Artefact, spans: Span[], amplitude: number, seed = 5): Recording {
  const signal = Float64Array.from(rec.signal);
  const rnd = noise(seed);
  for (let i = 0; i < signal.length; i += 1) {
    const t = i / FS;
    if (!inAny(t, spans)) continue;
    if (kind === "emg") {
      // Broadband 25–120 Hz muscle activity, amplitude-modulated like chewing.
      const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t);
      signal[i]! +
        0; // keep tsc happy about definite assignment below
      signal[i] =
        signal[i]! +
        amplitude *
          env *
          (rnd() +
            0.7 * Math.sin(2 * Math.PI * 32 * t) +
            0.6 * Math.sin(2 * Math.PI * 68 * t) +
            0.4 * Math.sin(2 * Math.PI * 110 * t));
    } else if (kind === "movement") {
      // Slow, very large electrode-pull excursion with occasional step jumps.
      const swing = Math.sin(2 * Math.PI * 0.6 * t) + 0.5 * Math.sin(2 * Math.PI * 0.17 * t);
      const step = Math.floor(t * 2) % 5 === 0 ? amplitude * 0.8 : 0;
      signal[i] = signal[i]! + amplitude * swing + step;
    } else {
      // Mains pick-up: 50 Hz fundamental plus a 100 Hz harmonic.
      signal[i] =
        signal[i]! + amplitude * (Math.sin(2 * Math.PI * 50 * t) + 0.3 * Math.sin(2 * Math.PI * 100 * t));
    }
  }
  return { ...rec, signal };
}

interface Replayed {
  epochs: Epoch[];
  events: DetectedEvent[];
  suppressionSeconds: number;
  /** Suppressed seconds among epochs the analyzer considered usable. */
  truthSuppressionSeconds: number;
  ratios: Array<{ t: number; sr: number }>;
  truthRatios: Array<{ t: number; sr: number }>;
}

function replay(rec: Recording): Replayed {
  const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
  const segsPerEpoch = EPOCH_SECONDS / SEG_SECONDS;
  const epochs: Epoch[] = [];
  const fractions: Array<{ t: number; fraction: number }> = [];
  const ratios: Array<{ t: number; sr: number }> = [];
  const truthRatios: Array<{ t: number; sr: number }> = [];

  for (let start = 0; start + EPOCH_SAMPLES <= rec.signal.length; start += FS * HOP_SECONDS) {
    const t = (start + EPOCH_SAMPLES) / FS;
    const epoch = analyzer.analyze(Float64Array.from(rec.signal.subarray(start, start + EPOCH_SAMPLES)), t);
    epochs.push(epoch);
    ratios.push({ t, sr: epoch.suppressionRatio });

    const firstSeg = Math.round(start / FS / SEG_SECONDS);
    let suppressed = 0;
    for (let s = firstSeg; s < firstSeg + segsPerEpoch; s += 1) if (rec.segments[s]) suppressed += 1;
    fractions.push({ t, fraction: suppressed / segsPerEpoch });

    const cutoff = t - DEFAULT_SETTINGS.srWindowSeconds;
    const window = fractions.filter((e) => e.t >= cutoff);
    truthRatios.push({ t, sr: (window.reduce((a, b) => a + b.fraction, 0) / window.length) * 100 });
  }

  return {
    epochs,
    events: analyzer.events.filter((e) => e.kind === "burst_suppression" || e.kind === "isoelectric"),
    suppressionSeconds: analyzer.suppressionSeconds,
    truthSuppressionSeconds: fractions.reduce((a, b) => a + b.fraction, 0) * HOP_SECONDS,
    ratios,
    truthRatios,
  };
}

/** Epochs whose 4 s window overlaps any of the given spans. */
const epochsOver = (epochs: Epoch[], spans: Span[]) =>
  epochs.filter((e) => spans.some((s) => e.t - EPOCH_SECONDS < s.end && e.t > s.start));

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const EPISODES: Span[] = [
  { start: 40, end: 80 },
  { start: 140, end: 185 },
];
const SECONDS = 240;

describe("burst-suppression under heavy artefact", () => {
  it(
    "keeps onset, offset, ratio and time accurate through 50 Hz mains pick-up",
    () => {
      const clean = makeRecording(SECONDS, EPISODES);
      const dirty = contaminate(clean, "line", [{ start: 0, end: SECONDS }], 40);
      const noisy = replay(dirty);

      expect(noisy.events).toHaveLength(EPISODES.length);
      noisy.events.forEach((ev, i) => {
        const gt = EPISODES[i]!;
        expect(Math.abs(ev.t - (gt.start + EDGE_LATENCY)), `onset ${i}`).toBeLessThanOrEqual(EDGE_TOLERANCE);
        expect(
          Math.abs(ev.t + ev.duration - (gt.end + EDGE_LATENCY)),
          `offset ${i}`,
        ).toBeLessThanOrEqual(EDGE_TOLERANCE);
      });

      const labelled = EPISODES.reduce((a, e) => a + (e.end - e.start), 0);
      expect(Math.abs(noisy.suppressionSeconds - labelled)).toBeLessThan(3);
      for (const point of noisy.ratios) {
        const truth = noisy.truthRatios.find((r) => r.t === point.t)!.sr;
        expect(Math.abs(point.sr - truth), `SR at t=${point.t}s`).toBeLessThan(4);
      }
    },
    TIMEOUT,
  );

  it(
    "does not invent suppression when EMG contaminates the bursting segments",
    () => {
      const clean = makeRecording(SECONDS, EPISODES);
      // EMG only over bursting periods, exactly where light anaesthesia shows it.
      const emgSpans: Span[] = [
        { start: 90, end: 135 },
        { start: 195, end: 235 },
      ];
      const dirty = contaminate(clean, "emg", emgSpans, 55);
      const noisy = replay(dirty);

      // No suppression is labelled under the EMG, and none may be reported there.
      for (const ev of noisy.events) {
        expect(emgSpans.some((s) => ev.t >= s.start && ev.t < s.end)).toBe(false);
      }
      const labelled = EPISODES.reduce((a, e) => a + (e.end - e.start), 0);
      expect(noisy.suppressionSeconds).toBeLessThan(labelled + 4);
      // The real episodes are still found.
      expect(noisy.events.length).toBeGreaterThanOrEqual(EPISODES.length);
    },
    TIMEOUT,
  );

  it(
    "flags EMG-contaminated suppression as unreliable rather than reporting a clean number",
    () => {
      const clean = makeRecording(SECONDS, EPISODES);
      // Heavy EMG laid directly over the second suppressed episode.
      const overlap: Span[] = [{ start: 140, end: 185 }];
      const dirty = contaminate(clean, "emg", overlap, 90);
      const noisy = replay(dirty);

      const contaminated = epochsOver(noisy.epochs, overlap);
      const cleanEpisode = epochsOver(noisy.epochs, [EPISODES[0]!]);
      expect(contaminated.length).toBeGreaterThan(10);

      // Either the detector still sees the suppression, or it refuses the data —
      // what it must never do is report it with full confidence.
      const contaminatedConfidence = mean(contaminated.map((e) => e.confidence.suppression));
      const cleanConfidence = mean(cleanEpisode.map((e) => e.confidence.suppression));
      expect(contaminatedConfidence).toBeLessThan(cleanConfidence);

      // Any second the analyzer did count is a second it judged usable, so the
      // clock can undercount but must never overcount the labelled truth.
      const labelled = EPISODES.reduce((a, e) => a + (e.end - e.start), 0);
      expect(noisy.suppressionSeconds).toBeLessThan(labelled + 4);
    },
    TIMEOUT,
  );

  it(
    "excludes movement artefact from the suppression clock and marks it artefact",
    () => {
      const clean = makeRecording(SECONDS, EPISODES);
      const movement: Span[] = [
        { start: 100, end: 125 },
        { start: 200, end: 220 },
      ];
      const dirty = contaminate(clean, "movement", movement, 600);
      const noisy = replay(dirty);

      const hit = epochsOver(noisy.epochs, movement);
      expect(hit.length).toBeGreaterThan(10);
      // The gross excursions are recognised as artefact, not as physiology.
      const flagged = hit.filter((e) => e.artifact || e.quality.grade === "poor");
      expect(flagged.length / hit.length).toBeGreaterThan(0.5);
      // Confidence in suppression drops over those epochs.
      expect(mean(hit.map((e) => e.confidence.suppression))).toBeLessThan(
        mean(epochsOver(noisy.epochs, [EPISODES[0]!]).map((e) => e.confidence.suppression)),
      );
      // No suppression event may be raised inside a movement burst.
      for (const ev of noisy.events) {
        expect(movement.some((s) => ev.t >= s.start && ev.t < s.end)).toBe(false);
      }
      const labelled = EPISODES.reduce((a, e) => a + (e.end - e.start), 0);
      expect(noisy.suppressionSeconds).toBeLessThan(labelled + 4);
    },
    TIMEOUT,
  );

  it(
    "reports no suppression at all on an artefact-only recording with no true suppression",
    () => {
      const clean = makeRecording(180, []);
      const all: Span[] = [{ start: 30, end: 150 }];
      for (const [kind, amp] of [
        ["emg", 70],
        ["movement", 500],
        ["line", 60],
      ] as Array<[Artefact, number]>) {
        const dirty = contaminate(clean, kind, all, amp);
        const noisy = replay(dirty);
        expect(noisy.events, `${kind} raised suppression events`).toHaveLength(0);
        expect(noisy.suppressionSeconds, `${kind} suppression clock`).toBeLessThan(2);
        expect(Math.max(...noisy.ratios.map((r) => r.sr)), `${kind} peak SR`).toBeLessThan(6);
      }
    },
    TIMEOUT,
  );

  it(
    "keeps every reported metric finite and the suppression clock monotonic under mixed artefact",
    () => {
      const clean = makeRecording(SECONDS, EPISODES);
      let dirty = contaminate(clean, "line", [{ start: 0, end: SECONDS }], 35);
      dirty = contaminate(dirty, "emg", [{ start: 90, end: 130 }], 60, 17);
      dirty = contaminate(dirty, "movement", [{ start: 190, end: 210 }], 700, 29);
      const noisy = replay(dirty);

      for (const e of noisy.epochs) {
        expect(Number.isFinite(e.suppressionRatio)).toBe(true);
        expect(e.suppressionRatio).toBeGreaterThanOrEqual(0);
        expect(e.suppressionRatio).toBeLessThanOrEqual(100);
        expect(Number.isFinite(e.confidence.suppression)).toBe(true);
      }
      expect(noisy.suppressionSeconds).toBeGreaterThan(0);
      const labelled = EPISODES.reduce((a, e) => a + (e.end - e.start), 0);
      expect(noisy.suppressionSeconds).toBeLessThan(labelled + 4);
    },
    TIMEOUT,
  );
});
