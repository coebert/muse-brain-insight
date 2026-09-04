/**
 * Continuous capture of every recording that passes through the monitor.
 *
 * Filing a case is a deliberate act, and until now anything the clinician did
 * not file was lost when the tab closed — including recordings that would have
 * been perfectly good training data. This module turns the live epoch stream
 * into small anonymised batches that are written to the database while the
 * case is still running.
 *
 * Nothing identifying is captured here: only the derived per-epoch numbers
 * (index, spectral edge, suppression, band powers, quality) and the device
 * setup. Names, hospital numbers and free text never reach this path.
 */

import type { Epoch } from "@/lib/eeg/analysis";

/** How often the monitor flushes new epochs to the database, in seconds. */
export const CAPTURE_FLUSH_SECONDS = 20;
/** Never send more than this many epochs in one request. */
export const CAPTURE_MAX_BATCH = 240;

export interface CaptureEpochRow {
  epochIndex: number;
  atSeconds: number;
  recordedAt: string;
  depthIndex: number | null;
  sef95: number | null;
  suppressionRatio: number | null;
  epochSuppression: number | null;
  totalPower: number | null;
  amplitudeUv: number | null;
  sqi: number | null;
  qualityGrade: string | null;
  artifact: boolean;
  bands: Record<string, number>;
  ratios: Record<string, number>;
  spectrum: number[];
}

export interface CaptureBatch {
  captureKey: string;
  startedAt: string;
  deviceName: string | null;
  montage: string | null;
  sampleRate: number | null;
  lineageKey: string | null;
  epochs: CaptureEpochRow[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function numericMap(input: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const n = num(v);
    if (n !== null) out[k] = n;
  }
  return out;
}

/**
 * Turn the epochs the monitor has produced since the last flush into rows.
 *
 * `fromIndex` is the count already sent, so a re-run of the same window sends
 * nothing twice; the database's `(capture_id, epoch_index)` key makes a retry
 * after a dropped response harmless as well.
 */
export function captureRowsFrom(
  epochs: Epoch[],
  fromIndex: number,
  sessionStart: number,
  limit = CAPTURE_MAX_BATCH,
): CaptureEpochRow[] {
  const rows: CaptureEpochRow[] = [];
  for (let i = fromIndex; i < epochs.length && rows.length < limit; i++) {
    const e = epochs[i]!;
    rows.push({
      epochIndex: i,
      atSeconds: e.t,
      recordedAt: new Date(sessionStart + e.t * 1000).toISOString(),
      depthIndex: num(e.depth?.index),
      sef95: num(e.sef95Raw ?? e.sef95),
      suppressionRatio: num(e.suppressionRatio),
      epochSuppression: num(e.epochSuppression),
      totalPower: num(e.totalPower),
      amplitudeUv: num(e.amplitudeUv),
      sqi: num(e.quality?.score),
      qualityGrade: e.quality?.grade ?? null,
      artifact: Boolean(e.artifact),
      bands: numericMap(e.bands),
      ratios: numericMap(e.ratios),
      // The full spectrum is the bulk of the payload; one decimal is plenty
      // for a dB value and roughly halves what we store.
      spectrum: Array.isArray(e.spectrum)
        ? e.spectrum.map((v) => Math.round(v * 10) / 10)
        : [],
    });
  }
  return rows;
}

/** A fresh capture key for one run of the monitor. */
export function newCaptureKey(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return rand;
}

export interface CaptureSummaryRow {
  captureKey: string;
  startedAt: string;
  lastSeenAt: string;
  deviceName: string | null;
  lineageKey: string | null;
  epochs: number;
  /** Whether the clinician filed this recording as a case. */
  filed: boolean;
  /** Whether the nightly job turned an unfiled recording into a case. */
  harvested: boolean;
}

export interface CaptureStats {
  captures: number;
  epochs: number;
  /** Recordings that reached the training pool, either filed or harvested. */
  inPool: number;
  /** Recordings still waiting for the harvest to pick them up. */
  waiting: number;
  hours: number;
  recent: CaptureSummaryRow[];
}

/** Minutes of signal represented by a number of 1 s-hop epochs. */
export function captureHours(epochs: number, hopSeconds = 1): number {
  return (epochs * hopSeconds) / 3600;
}
