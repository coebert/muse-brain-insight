/**
 * End-to-end: stored-batch integrity and deterministic reload.
 *
 * A saved case is evidence. This test drives a synthetic Muse 2 session through
 * the real analyzer, serialises the epochs and events with the same functions
 * the save path uses, checksums every insert batch, pushes the rows through a
 * simulated database round-trip (JSON transport, PostgREST-style reordering,
 * retried/duplicated batches), and then asserts:
 *   - the reloaded spectral arrays and derived events are bit-identical to the
 *     originals, batch checksums and session root checksum included,
 *   - re-running the identical stream through a fresh analyzer reproduces the
 *     same rows and the same root checksum (the pipeline is deterministic),
 *   - every realistic corruption — a truncated batch, a duplicated row, a
 *     dropped spectral bin, a single flipped value, a re-ordered reload, a NaN
 *     — is detected and localised to the batch and offset it came from,
 *   - a reload never silently "repairs" data: no problem is reported for a
 *     clean round-trip, and the DSA rebuilt from stored rows matches the DSA
 *     rebuilt from the live stream column for column.
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
  EPOCH_BATCH_SIZE,
  buildManifest,
  canonicalise,
  checksum,
  describeIntegrity,
  epochPayload,
  eventPayload,
  verifyReload,
} from "./batch-integrity";
import { MUSE_SAMPLE_RATE, makeEegFilter } from "./dsp";

const FS = MUSE_SAMPLE_RATE;
const EPOCH_LEN = EPOCH_SECONDS * FS;
const SESSION_SECONDS = 600;
const SUPPRESSION = { start: 180, end: 240 };
const ICTAL = { start: 380, end: 430 };

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

/** Deterministic anaesthetic stream with one suppression run and one ictal run. */
function buildStream(): Float64Array {
  const noise = rng(90_210);
  const filter = makeEegFilter();
  const bands = [
    { f: 1.1, amp: 27, jitter: 0.05 },
    { f: 2.9, amp: 15, jitter: 0.07 },
    { f: 6.1, amp: 7, jitter: 0.1 },
    { f: 10.4, amp: 11, jitter: 0.12 },
  ].map((b) => ({ ...b, phase: noise() * Math.PI }));
  const dt = 1 / FS;
  const out = new Float64Array(SESSION_SECONDS * FS);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / FS;
    const spindle = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.05 * t);
    let bg = 21 * noise();
    for (const b of bands) {
      b.phase += 2 * Math.PI * b.f * dt + b.jitter * noise();
      bg += b.amp * (b.f > 8 ? spindle : 1) * Math.sin(b.phase);
    }
    let v = bg;
    if (t >= SUPPRESSION.start && t < SUPPRESSION.end) {
      const edge = Math.min(1, (t - SUPPRESSION.start) / 12, (SUPPRESSION.end - t) / 12);
      v = (1 - edge) * bg + edge * (2.5 * Math.sin(2 * Math.PI * 1.4 * t) + 0.3 * noise());
    } else if (t >= ICTAL.start && t < ICTAL.end) {
      const ramp = Math.min(1, (t - ICTAL.start) / 10);
      const amp = 62 * ramp;
      const phase = 2 * Math.PI * 3 * t;
      v =
        amp * Math.sin(phase) +
        0.45 * amp * Math.sin(2 * phase + 0.4) +
        0.2 * amp * Math.sin(3 * phase) +
        4 * noise();
    }
    out[i] = filter.process(v);
  }
  return out;
}

const STREAM = buildStream();

interface RunResult {
  epochs: Epoch[];
  events: DetectedEvent[];
}

/** Replay the stream through a fresh analyzer, exactly as the monitor does. */
function runPipeline(): RunResult {
  const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
  const epochs: Epoch[] = [];
  for (let end = EPOCH_LEN; end <= STREAM.length; end += FS) {
    epochs.push(analyzer.analyze(Float64Array.from(STREAM.subarray(end - EPOCH_LEN, end)), end / FS));
  }
  return { epochs, events: [...analyzer.events] };
}

const LIVE = runPipeline();
const EPOCH_ROWS = LIVE.epochs.map(epochPayload);
const EVENT_ROWS = LIVE.events.map(eventPayload);
const EPOCH_MANIFEST = buildManifest("epochs", EPOCH_ROWS, EPOCH_BATCH_SIZE);
const EVENT_MANIFEST = buildManifest("events", EVENT_ROWS, EPOCH_BATCH_SIZE);

/**
 * A database round-trip: rows are serialised to JSON on insert, come back in
 * whatever order the query asked for, and arrive as plain objects.
 */
function roundTrip<T extends { t_offset_seconds: number }>(
  rows: T[],
  { shuffle = false } = {},
): T[] {
  // Reads always ask for `order(t_offset_seconds)`, so a reload arrives sorted
  // even though events are written when their episode closes.
  const out = (JSON.parse(JSON.stringify(rows)) as T[]).sort(
    (a, b) => a.t_offset_seconds - b.t_offset_seconds,
  );
  if (shuffle) {
    // Deterministic reversal of each batch — the worst case a missing
    // ORDER BY can produce.
    for (let i = 0; i < out.length; i += EPOCH_BATCH_SIZE) {
      const chunk = out.slice(i, i + EPOCH_BATCH_SIZE).reverse();
      chunk.forEach((row, j) => (out[i + j] = row));
    }
  }
  return out;
}

const clone = <T,>(rows: T[]): T[] => JSON.parse(JSON.stringify(rows)) as T[];

describe("storage integrity: checksummed batches and deterministic reload", () => {
  it("produces a manifest that covers every row in fixed-size batches", () => {
    expect(EPOCH_ROWS.length).toBeGreaterThan(500);
    expect(EPOCH_MANIFEST.rowCount).toBe(EPOCH_ROWS.length);
    const batched = EPOCH_MANIFEST.batches.reduce((n, b) => n + b.count, 0);
    expect(batched).toBe(EPOCH_ROWS.length);
    expect(EPOCH_MANIFEST.batches.length).toBe(
      Math.ceil(EPOCH_ROWS.length / EPOCH_BATCH_SIZE),
    );
    for (const b of EPOCH_MANIFEST.batches.slice(0, -1)) expect(b.count).toBe(EPOCH_BATCH_SIZE);
    // Batches tile the session in time without overlap.
    EPOCH_MANIFEST.batches.forEach((b, i) => {
      expect(b.lastT).toBeGreaterThanOrEqual(b.firstT);
      if (i > 0) expect(b.firstT).toBeGreaterThan(EPOCH_MANIFEST.batches[i - 1]!.lastT);
    });
    expect(EPOCH_MANIFEST.rootChecksum).toMatch(/^[0-9a-f]{16}$/);
    expect(EVENT_MANIFEST.rowCount).toBe(EVENT_ROWS.length);
  });

  it("verifies a clean reload of spectral arrays and events", () => {
    const epochReport = verifyReload(EPOCH_MANIFEST, roundTrip(EPOCH_ROWS));
    expect(epochReport.problems).toEqual([]);
    expect(epochReport.ok).toBe(true);
    expect(describeIntegrity(epochReport)).toContain("verified");

    const eventReport = verifyReload(EVENT_MANIFEST, roundTrip(EVENT_ROWS));
    expect(eventReport.ok).toBe(true);

    // The spectra themselves survive transport bin for bin.
    const reloaded = roundTrip(EPOCH_ROWS);
    reloaded.forEach((row, i) => {
      const original = EPOCH_ROWS[i]!;
      expect(row.spectrum.length).toBe(original.spectrum.length);
      expect(row.spectrum).toEqual(original.spectrum);
      expect(row.t_offset_seconds).toBe(original.t_offset_seconds);
    });
  });

  it("tolerates unordered reloads without reporting corruption", () => {
    const report = verifyReload(EPOCH_MANIFEST, roundTrip(EPOCH_ROWS, { shuffle: true }));
    // Order is re-established before hashing, so only the ordering note appears.
    expect(report.problems.filter((p) => p.kind !== "out_of_order")).toEqual([]);
    expect(report.actual.rootChecksum).toBe(EPOCH_MANIFEST.rootChecksum);
  });

  it("reproduces identical rows and checksums on a second pipeline run", () => {
    const repeat = runPipeline();
    const rows = repeat.epochs.map(epochPayload);
    const manifest = buildManifest("epochs", rows, EPOCH_BATCH_SIZE);
    expect(manifest.rootChecksum).toBe(EPOCH_MANIFEST.rootChecksum);
    expect(manifest.batches.map((b) => b.checksum)).toEqual(
      EPOCH_MANIFEST.batches.map((b) => b.checksum),
    );
    // Derived events are deterministic too — same kinds, offsets and durations.
    expect(repeat.events.map(eventPayload)).toEqual(EVENT_ROWS);
    expect(checksum(repeat.events.map(eventPayload))).toBe(checksum(EVENT_ROWS));
  });

  it("rebuilds the same DSA from stored rows as from the live stream", () => {
    const reloaded = roundTrip(EPOCH_ROWS);
    expect(reloaded.length).toBe(LIVE.epochs.length);
    reloaded.forEach((row, i) => {
      const live = LIVE.epochs[i]!;
      expect(row.t_offset_seconds).toBeCloseTo(live.t, 2);
      // Each stored DSA column is the live column at storage precision.
      row.spectrum.forEach((v, bin) => expect(v).toBeCloseTo(live.spectrum[bin]!, 1));
      expect(row.spectral_edge_95).toBeCloseTo(live.sef95, 2);
      expect(row.suppression_ratio).toBeCloseTo(live.suppressionRatio, 2);
      expect(row.is_suppressed).toBe(live.isSuppressed);
      expect(row.seizure_score).toBeCloseTo(live.seizureScore, 3);
    });
  });

  it("detects a truncated insert batch and names the missing rows", () => {
    const rows = clone(EPOCH_ROWS);
    rows.splice(EPOCH_BATCH_SIZE * 2 + 17, 5);
    const report = verifyReload(EPOCH_MANIFEST, rows);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === "row_count")).toBe(true);
    expect(report.problems.filter((p) => p.kind === "missing_row")).toHaveLength(5);
    expect(report.problems.some((p) => p.kind === "root_checksum")).toBe(true);
    // The damage is localised: earlier batches still verify.
    const badBatches = report.problems
      .filter((p) => p.kind === "batch_checksum")
      .map((p) => p.batch!);
    expect(Math.min(...badBatches)).toBe(2);
  });

  it("detects a duplicated row from a retried batch insert", () => {
    const rows = clone(EPOCH_ROWS);
    rows.splice(40, 0, clone([EPOCH_ROWS[40]!])[0]!);
    const report = verifyReload(EPOCH_MANIFEST, rows);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === "row_count")).toBe(true);
    expect(report.problems.some((p) => p.kind === "batch_checksum" && p.batch === 0)).toBe(true);
  });

  it("detects a single altered spectral bin and pinpoints the epoch", () => {
    const rows = clone(EPOCH_ROWS);
    const target = 333;
    rows[target]!.spectrum[9] = Number((rows[target]!.spectrum[9]! + 0.1).toFixed(1));
    const report = verifyReload(EPOCH_MANIFEST, rows);
    expect(report.ok).toBe(false);
    const rowProblems = report.problems.filter((p) => p.kind === "row_checksum");
    expect(rowProblems).toHaveLength(1);
    expect(rowProblems[0]!.t).toBeCloseTo(EPOCH_ROWS[target]!.t_offset_seconds, 2);
    expect(report.problems.some((p) => p.kind === "batch_checksum" && p.batch === 1)).toBe(true);
  });

  it("detects a dropped spectral bin even when every remaining value matches", () => {
    const rows = clone(EPOCH_ROWS);
    rows[10]!.spectrum.pop();
    const report = verifyReload(EPOCH_MANIFEST, rows);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === "row_checksum")).toBe(true);
  });

  it("detects a flipped derived event and a shifted event offset", () => {
    expect(EVENT_ROWS.length).toBeGreaterThan(0);
    const shifted = clone(EVENT_ROWS);
    shifted[0]!.t_offset_seconds = Number((shifted[0]!.t_offset_seconds + 1).toFixed(2));
    expect(verifyReload(EVENT_MANIFEST, shifted).ok).toBe(false);

    const relabelled = clone(EVENT_ROWS);
    relabelled[0]!.severity = relabelled[0]!.severity === "critical" ? "warning" : "critical";
    const report = verifyReload(EVENT_MANIFEST, relabelled);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.kind === "row_checksum")).toBe(true);
  });

  it("refuses to hash a non-finite value rather than storing it as null", () => {
    const rows = clone(EPOCH_ROWS);
    (rows[5]! as { spectral_edge_95: number }).spectral_edge_95 = Number.NaN;
    expect(() => checksum(rows[5])).toThrow(/Non-finite/);
    // Nothing in a clean session trips that guard.
    expect(() => checksum(EPOCH_ROWS)).not.toThrow();
    expect(() => checksum(EVENT_ROWS)).not.toThrow();
  });

  it("hashes canonically: key order and -0 do not change a checksum", () => {
    const a = { b: 1, a: [1, 2, { z: 0, y: "x" }] };
    const b = { a: [1, 2, { y: "x", z: -0 }], b: 1 };
    expect(canonicalise(a)).toBe(canonicalise(b));
    expect(checksum(a)).toBe(checksum(b));
    // ...but a real change always does.
    expect(checksum({ ...a, b: 1.0001 })).not.toBe(checksum(a));
  });
});

