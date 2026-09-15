/**
 * End-to-end: a four-hour case with two headband dropouts, checked for
 * timeline sync.
 *
 * The question this answers is the clinical one: after the band drops out for
 * minutes at a time and comes back, does everything still line up? The saved
 * waveform, the depth trace and the clinician's phase markers all live on one
 * clock — seconds since the case started — and an outage is exactly where that
 * clock can slip, because a dropout writes nothing while wall time keeps
 * moving.
 *
 * Each archived sample here carries its own case-clock second as its value, so
 * reading the archive back at any time tells us directly whether that second
 * of signal is filed where it belongs.
 */
import { describe, expect, it } from "vitest";

import { phaseSpans, type CaseObservation, type CasePhase } from "../case-observations";
import { RAW_ARCHIVE_HZ, RAW_ARCHIVE_SECONDS, createRawArchive } from "../raw-archive";

const FS = 256;
const CHUNK = 12;
const CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;

/** Four hours — a long list case, well past the one-hour archive capacity. */
const CASE_SECONDS = 4 * 60 * 60;

/** Dropouts: [start second, length in seconds]. */
const DROPOUTS: Array<[number, number]> = [
  [55 * 60, 8 * 60], // 8 minutes, well inside the retained hour at the time
  [3 * 60 * 60, 21 * 60], // 21 minutes, late in a long case
];

const inDropout = (t: number) =>
  DROPOUTS.some(([start, length]) => t >= start && t < start + length);

/** Clinician phase taps, at case-clock seconds. */
const PHASE_TAPS: Array<[CasePhase, number]> = [
  ["induction", 120],
  ["maintenance", 15 * 60],
  ["emergence", 3 * 60 * 60 + 30 * 60], // after the second, longer dropout
  ["recovery", 3 * 60 * 60 + 50 * 60],
];

function phaseObservations(): CaseObservation[] {
  return PHASE_TAPS.map(([phase, atSeconds], i) => ({
    id: `p${i}`,
    caseCode: "SIM-LONG",
    sessionId: "sim",
    kind: "phase" as const,
    atSeconds,
    moaas: null,
    stimulus: null,
    drugName: null,
    dose: null,
    doseUnit: null,
    route: null,
    eventType: null,
    phase,
    note: null,
  }));
}

interface Replay {
  archive: ReturnType<typeof createRawArchive>;
  /** Depth samples the analyser path produced, keyed by case second. */
  depth: Map<number, number>;
  streamedSeconds: number;
}

/**
 * Replays the case in frames, with the clock advancing through the dropouts
 * even though no samples arrive — exactly what the headband does.
 */
function replay(): Replay {
  const archive = createRawArchive();
  const depth = new Map<number, number>();
  const startMs = 1_750_000_000_000;
  let streamedSeconds = 0;

  for (let start = 0; start + CHUNK <= CASE_SECONDS * FS; start += CHUNK) {
    const t0 = start / FS;
    if (inDropout(t0)) continue;
    const nowMs = startMs + ((start + CHUNK) / FS) * 1000;
    for (const ch of CHANNELS) {
      const samples = new Float64Array(CHUNK);
      // Every sample carries the case second it belongs to.
      for (let i = 0; i < CHUNK; i += 1) samples[i] = Math.floor((start + i) / FS);
      archive.push(ch, samples, FS, nowMs);
    }
    streamedSeconds += CHUNK / FS;

    // One epoch per second, stamped on the case clock as the monitor does.
    const second = Math.floor((start + CHUNK - 1) / FS);
    if (second >= 0 && !depth.has(second)) {
      depth.set(second, 40 + 20 * Math.sin(second / 600));
    }
  }

  return { archive, depth, streamedSeconds };
}

describe("four-hour case with dropouts", () => {
  const run = replay();
  const channel = CHANNELS[0];

  it("keeps the waveform on the case clock across both dropouts", () => {
    // Real streamed signal is shorter than the case by the outage time, but
    // the archive must still span the whole case: the gaps are padded.
    const droppedSeconds = DROPOUTS.reduce((a, [, len]) => a + len, 0);
    expect(run.streamedSeconds).toBeLessThan(CASE_SECONDS - droppedSeconds + 1);
    expect(run.archive.duration(channel)).toBeGreaterThan(CASE_SECONDS - 2);
    expect(run.archive.duration(channel)).toBeLessThan(CASE_SECONDS + 2);
  });

  it("reads back each second of signal at its own case-clock time", () => {
    // Only the most recent hour is retained; probe inside it.
    const retainedFrom = run.archive.retainedFrom(channel);
    expect(retainedFrom).toBeGreaterThan(CASE_SECONDS - RAW_ARCHIVE_SECONDS - 2);

    const probes = [
      Math.round(retainedFrom) + 60, // just inside the retained window
      DROPOUTS[1]![0] - 30, // immediately before the long dropout
      DROPOUTS[1]![0] + DROPOUTS[1]![1] + 30, // immediately after it
      CASE_SECONDS - 120, // near the end
    ].filter((t) => !inDropout(t));
    expect(probes.length).toBeGreaterThanOrEqual(3);
    for (const t of probes) {
      const seg = run.archive.read(channel, t, t + 1);
      expect(seg.length).toBe(RAW_ARCHIVE_HZ);
      // Every sample in that second is stamped with that second.
      expect(Math.round(seg[0]!)).toBe(t);
      expect(Math.round(seg[seg.length - 1]!)).toBe(t);
    }
  });

  it("files the dropout as silence in its own place, not as missing time", () => {
    const [start, length] = DROPOUTS[1]!;
    const mid = start + Math.floor(length / 2);
    const seg = run.archive.read(channel, mid, mid + 1);
    expect(seg.length).toBe(RAW_ARCHIVE_HZ);
    expect(Math.max(...seg)).toBe(0);
    // And the second the band returns is real signal again, on time.
    const back = run.archive.read(channel, start + length + 1, start + length + 2);
    expect(Math.round(back[0]!)).toBe(start + length + 1);
  });

  it("keeps the depth trace on the same clock after the drop", () => {
    const [start, length] = DROPOUTS[1]!;
    // No depth is produced while the band is away — the trace is blank there,
    // rather than later readings sliding back to fill the gap.
    for (let t = start + 5; t < start + length - 5; t += 60) {
      expect(run.depth.has(t)).toBe(false);
    }
    // Readings resume at their true case-clock seconds.
    expect(run.depth.has(start - 5)).toBe(true);
    expect(run.depth.has(start + length + 5)).toBe(true);
    const last = Math.max(...run.depth.keys());
    expect(last).toBeGreaterThan(CASE_SECONDS - 5);
  });

  it("lands phase markers on the waveform they were tapped over", () => {
    const spans = phaseSpans(phaseObservations());
    expect(spans.map((s) => s.phase)).toEqual([
      "induction",
      "maintenance",
      "emergence",
      "recovery",
    ]);

    const retainedFrom = run.archive.retainedFrom(channel);
    for (const span of spans) {
      if (span.startSeconds < retainedFrom) continue; // trimmed out of the ring
      const seg = run.archive.read(channel, span.startSeconds, span.startSeconds + 1);
      // The marker points at the second of signal that was live when tapped.
      expect(Math.round(seg[0]!)).toBe(span.startSeconds);
    }

    // The emergence tap sits after the long dropout; without gap padding it
    // would have pointed 21 minutes of signal too late.
    const emergence = spans.find((s) => s.phase === "emergence")!;
    expect(emergence.startSeconds).toBeGreaterThan(DROPOUTS[1]![0] + DROPOUTS[1]![1]);
    const seg = run.archive.read(channel, emergence.startSeconds, emergence.startSeconds + 1);
    expect(Math.round(seg[0]!)).toBe(emergence.startSeconds);
  });
});
