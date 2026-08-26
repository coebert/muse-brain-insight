/**
 * Storage integrity for saved cases.
 *
 * A clinical record is only useful if what comes back out of the database is
 * provably the same thing that went in. This module owns the exact wire shape
 * of an epoch/event row (shared with the save path, so there is a single
 * serialiser) and computes deterministic checksums over each insert batch plus
 * a manifest for the whole session. Reloading a case can then be verified
 * row-by-row and batch-by-batch: a truncated insert, a duplicated row, a
 * silently rounded spectral bin or a flipped value all show up as a checksum
 * mismatch naming the batch and the field, rather than as a quietly wrong
 * density-spectral array months later.
 */
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";

/** Rows per insert batch — matches the chunk size used by the save path. */
export const EPOCH_BATCH_SIZE = 200;

export type EpochPayload = ReturnType<typeof epochPayload>;
export type EventPayload = ReturnType<typeof eventPayload>;

/**
 * Database column values for one analysed epoch, at the precision actually
 * stored. Rounding happens here — and only here — so the checksum is taken
 * over the same numbers Postgres receives.
 */
export function epochPayload(e: Epoch) {
  return {
    t_offset_seconds: Number(e.t.toFixed(2)),
    suppression_ratio: Number(e.suppressionRatio.toFixed(2)),
    is_suppressed: e.isSuppressed,
    seizure_score: Number(e.seizureScore.toFixed(3)),
    total_power: Number(e.totalPower.toFixed(3)),
    spectral_edge_95: Number(e.sef95.toFixed(2)),
    depth_index: e.depth.index === null ? null : Number(e.depth.index.toFixed(1)),
    depth_state: e.depth.state,
    consciousness_index: e.composite.cIndex,
    nociception_index: e.composite.nIndex,
    composite_components: {
      fast_slow: Number(e.composite.components.fastSlow.toFixed(3)),
      entropy: Number(e.composite.components.entropy.toFixed(3)),
      bsr: Number(e.composite.components.bsr.toFixed(2)),
      emg_drive: Number(e.composite.components.emgDrive.toFixed(3)),
      reactivity: Number(e.composite.components.reactivity.toFixed(3)),
      entropy_gap: Number(e.composite.components.entropyGap.toFixed(3)),
    } as Record<string, number>,
    depth_components: {
      c1: Number.isFinite(e.depth.components.betaRatio)
        ? Number(e.depth.components.betaRatio.toFixed(4))
        : null,
      c2: Number.isFinite(e.depth.components.synchFastSlow)
        ? Number(e.depth.components.synchFastSlow.toFixed(4))
        : null,
      c3: Number.isFinite(e.depth.components.slowWave)
        ? Number(e.depth.components.slowWave.toFixed(4))
        : null,
      bsr: Number(e.depth.components.bsr.toFixed(2)),
    } as Record<string, number | null>,
    bands: { ...e.bands } as Record<string, number>,
    entropy: {
      shannon: Number(e.entropy.shannon.toFixed(3)),
      se95: Number(e.entropy.se95.toFixed(3)),
      state: Number(e.entropy.state.toFixed(3)),
      response: Number(e.entropy.response.toFixed(3)),
    } as Record<string, number>,
    power_ratios: {
      delta_alpha: Number(e.ratios.deltaAlpha.toFixed(3)),
      beta_alpha: Number(e.ratios.betaAlpha.toFixed(3)),
      theta_alpha: Number(e.ratios.thetaAlpha.toFixed(3)),
    } as Record<string, number>,
    spectrum: Array.from(e.spectrum, (v) => Number(v.toFixed(1))),
  };
}

/** Database column values for one detected event, at stored precision. */
export function eventPayload(ev: DetectedEvent) {
  return {
    kind: ev.kind,
    severity: ev.severity,
    t_offset_seconds: Number(ev.t.toFixed(2)),
    duration_seconds: Number(ev.duration.toFixed(1)),
    detail: ev.detail,
  };
}

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

/**
 * Stable JSON: keys sorted, -0 normalised to 0, non-finite values rejected so
 * a NaN can never be hashed as `null` and slip through unnoticed.
 */
export function canonicalise(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite value cannot be stored: ${value}`);
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
  }
  throw new Error(`Unsupported value in stored row: ${typeof value}`);
}

/**
 * 64-bit FNV-1a over the canonical form, as 16 hex characters. Synchronous and
 * dependency-free: this runs on every save, in the browser, on rows that are
 * already in memory, and only needs to catch corruption — not resist attack.
 */
export function checksum(value: unknown): string {
  const text = canonicalise(value);
  let hi = 0xcbf2_9ce4;
  let lo = 0x8422_2325;
  for (let i = 0; i < text.length; i += 1) {
    lo ^= text.charCodeAt(i) & 0xffff;
    // Multiply by the 64-bit FNV prime (2^40 + 2^8 + 0xb3) in 32-bit halves.
    const loProd = lo * 0x1b3;
    const hiProd = hi * 0x1b3 + ((lo << 8) >>> 0) + Math.floor(loProd / 0x1_0000_0000);
    lo = loProd >>> 0;
    hi = (hiProd + ((lo << 24) >>> 0)) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

export interface BatchManifest {
  /** Zero-based batch index, in insert order. */
  index: number;
  /** Rows in this batch. */
  count: number;
  /** Offset, seconds, of the first and last row in the batch. */
  firstT: number;
  lastT: number;
  /** Checksum of the batch's rows in insert order. */
  checksum: string;
}

export interface SessionManifest {
  /** What the manifest covers. */
  kind: "epochs" | "events";
  rowCount: number;
  batches: BatchManifest[];
  /** Checksum over the ordered batch checksums — one value for the session. */
  rootChecksum: string;
  /** Per-row checksums keyed by offset, for pinpointing a single bad row. */
  rowChecksums: Record<string, string>;
}

function tOf(row: { t_offset_seconds: number }): number {
  return row.t_offset_seconds;
}

/**
 * Split rows into batches and checksum each one. Batches are defined over the
 * canonical time ordering rather than whatever order the rows happened to be
 * inserted in (detected events are appended when an episode closes, and a
 * reload comes back ordered by offset), so save and reload agree.
 */
export function buildManifest(
  kind: "epochs" | "events",
  rows: Array<{ t_offset_seconds: number }>,
  batchSize = EPOCH_BATCH_SIZE,
): SessionManifest {
  const ordered = [...rows].sort((a, b) => tOf(a) - tOf(b));
  const batches: BatchManifest[] = [];
  for (let i = 0; i < ordered.length; i += batchSize) {
    const chunk = ordered.slice(i, i + batchSize);
    batches.push({
      index: batches.length,
      count: chunk.length,
      firstT: tOf(chunk[0]!),
      lastT: tOf(chunk[chunk.length - 1]!),
      checksum: checksum(chunk),
    });
  }
  const rowChecksums: Record<string, string> = {};
  ordered.forEach((row, i) => {
    // Events can repeat an offset (a marker on the same second as an alert),
    // so the key carries the ordinal too.
    rowChecksums[`${tOf(row).toFixed(2)}#${i}`] = checksum(row);
  });
  return {
    kind,
    rowCount: ordered.length,
    batches,
    rootChecksum: checksum(batches.map((b) => b.checksum)),
    rowChecksums,
  };
}

export interface IntegrityProblem {
  kind:
    | "row_count"
    | "batch_checksum"
    | "row_checksum"
    | "root_checksum"
    | "missing_row"
    | "extra_row"
    | "out_of_order";
  detail: string;
  /** Batch index, when the problem is localised to one batch. */
  batch?: number;
  /** Offset, seconds, when the problem is localised to one row. */
  t?: number;
}

export interface IntegrityReport {
  ok: boolean;
  expected: SessionManifest;
  actual: SessionManifest;
  problems: IntegrityProblem[];
}

/**
 * Verify reloaded rows against the manifest recorded at save time. Rows are
 * re-sorted by offset first, because PostgREST guarantees order only when the
 * query asks for it and a reload must not be judged corrupt for that.
 */
export function verifyReload(
  expected: SessionManifest,
  reloaded: Array<{ t_offset_seconds: number }>,
  batchSize = EPOCH_BATCH_SIZE,
): IntegrityReport {
  const problems: IntegrityProblem[] = [];
  const sorted = [...reloaded].sort((a, b) => tOf(a) - tOf(b));
  for (let i = 1; i < reloaded.length; i += 1) {
    if (tOf(reloaded[i]!) < tOf(reloaded[i - 1]!)) {
      problems.push({
        kind: "out_of_order",
        detail: `row ${i} at ${tOf(reloaded[i]!)}s follows ${tOf(reloaded[i - 1]!)}s`,
        t: tOf(reloaded[i]!),
      });
      break;
    }
  }

  const actual = buildManifest(expected.kind, sorted, batchSize);

  if (actual.rowCount !== expected.rowCount) {
    problems.push({
      kind: "row_count",
      detail: `expected ${expected.rowCount} rows, reloaded ${actual.rowCount}`,
    });
    const expectedKeys = new Set(Object.keys(expected.rowChecksums).map((k) => k.split("#")[0]!));
    const actualKeys = new Set(Object.keys(actual.rowChecksums).map((k) => k.split("#")[0]!));
    for (const key of expectedKeys) {
      if (!actualKeys.has(key)) {
        problems.push({ kind: "missing_row", detail: `no row at ${key}s`, t: Number(key) });
      }
    }
    for (const key of actualKeys) {
      if (!expectedKeys.has(key)) {
        problems.push({ kind: "extra_row", detail: `unexpected row at ${key}s`, t: Number(key) });
      }
    }
  }

  const batchCount = Math.max(expected.batches.length, actual.batches.length);
  for (let i = 0; i < batchCount; i += 1) {
    const want = expected.batches[i];
    const got = actual.batches[i];
    if (!want || !got || want.checksum !== got.checksum) {
      problems.push({
        kind: "batch_checksum",
        batch: i,
        detail: want
          ? got
            ? `batch ${i} (${want.firstT}-${want.lastT}s) checksum ${got.checksum} ≠ ${want.checksum}`
            : `batch ${i} missing from reload`
          : `unexpected batch ${i} in reload`,
      });
    }
  }

  // Pinpoint the offending rows inside any mismatched batch. Several events can
  // share one offset, so checksums are compared as a multiset per offset.
  const expectedByT = new Map<string, string[]>();
  for (const [key, sum] of Object.entries(expected.rowChecksums)) {
    const t = key.split("#")[0]!;
    expectedByT.set(t, [...(expectedByT.get(t) ?? []), sum]);
  }
  const actualByT = new Map<string, string[]>();
  for (const [key, sum] of Object.entries(actual.rowChecksums)) {
    const t = key.split("#")[0]!;
    actualByT.set(t, [...(actualByT.get(t) ?? []), sum]);
  }
  for (const [t, sums] of actualByT) {
    const want = expectedByT.get(t);
    if (!want) continue;
    const remaining = [...want];
    let mismatched = false;
    for (const sum of sums) {
      const at = remaining.indexOf(sum);
      if (at === -1) mismatched = true;
      else remaining.splice(at, 1);
    }
    if (mismatched) {
      problems.push({
        kind: "row_checksum",
        t: Number(t),
        detail: `row at ${t}s does not match the saved checksum`,
      });
    }
  }

  if (actual.rootChecksum !== expected.rootChecksum) {
    problems.push({
      kind: "root_checksum",
      detail: `session checksum ${actual.rootChecksum} ≠ ${expected.rootChecksum}`,
    });
  }

  return { ok: problems.length === 0, expected, actual, problems };
}

/** Human-readable one-liner for the save/reload UI and logs. */
export function describeIntegrity(report: IntegrityReport): string {
  if (report.ok) {
    return `${report.expected.rowCount} ${report.expected.kind} verified (${report.expected.rootChecksum})`;
  }
  const first = report.problems[0]!;
  return `${report.problems.length} integrity problem(s) in ${report.expected.kind}: ${first.detail}`;
}
