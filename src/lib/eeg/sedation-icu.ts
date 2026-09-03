/**
 * DOSE-I and I-CARE ingest — real procedural-sedation and post-arrest ICU EEG.
 *
 *   1. DOSE-I (Zenodo)  — 171 endoscopy procedural-sedation recordings, two
 *      fronto-temporal channels at 125 Hz, with propofol dosing. Closest open
 *      analogue to this app's own use case, but still a different montage.
 *
 *   2. I-CARE (PhysioNet Challenge 2023) — continuous ICU EEG after cardiac
 *      arrest, hours per patient, rich in burst suppression and full 10-20
 *      clinical montages exported per channel.
 *
 * Both arrive here as sample CSVs (time column optional, one column per
 * channel, optional `label`/`state` column). DSA features and the
 * burst-suppression verdict are derived with the same detector the bedside
 * pipeline uses; a published label column, when present, is kept verbatim and
 * marked `dataset` so external validation may treat it as ground truth.
 *
 * Every row keeps its own `source_lineage` and its harmonisation record. These
 * collections are population-level material only — they never enter
 * device-specific paired alignment.
 */

import type { HarmonizationRecord, SourceMontage } from "./harmonization";
import {
  deriveEpochsFromRaw,
  normalisePhysionetLabel,
  type PhysionetEpoch,
  type PhysionetImportRow,
} from "./physionet";

export type SedationIcuDataset = "dose1" | "icare";

export const DOSE1_SOURCE = "zenodo-dose-i";
export const DOSE1_LINEAGE = "external:zenodo:dose-i";
export const ICARE_SOURCE = "physionet-i-care";
export const ICARE_LINEAGE = "external:physionet:i-care";

export function sedationIcuLineage(dataset: SedationIcuDataset): {
  source: string;
  lineage: string;
} {
  return dataset === "dose1"
    ? { source: DOSE1_SOURCE, lineage: DOSE1_LINEAGE }
    : { source: ICARE_SOURCE, lineage: ICARE_LINEAGE };
}

/** Native rate each collection publishes, used when the file has no clock. */
export const DEFAULT_SAMPLE_RATE: Record<SedationIcuDataset, number> = {
  dose1: 125,
  icare: 100,
};

/** Montage each collection records on, for the harmonisation audit record. */
export const SEDATION_ICU_MONTAGE: Record<SedationIcuDataset, SourceMontage> = {
  dose1: {
    channel: "FP1-F7",
    reference: "bipolar-frontal",
    lowHz: 0.5,
    highHz: 45,
    sampleRateHz: 125,
    note: "Two-channel fronto-temporal bipolar sedation montage (125 Hz).",
  },
  icare: {
    channel: "FP1",
    reference: "average",
    lowHz: 0.5,
    highHz: 30,
    sampleRateHz: 100,
    note: "Clinical 10-20 ICU montage, commonly exported average-referenced.",
  },
};

/* ------------------------------------------------------------------ CSV --- */

function splitLine(line: string): string[] {
  return line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ""));
}

const TIME_KEYS = new Set(["time", "t", "seconds", "sec", "timestamp", "time_s"]);
const LABEL_KEYS = new Set(["label", "state", "stage", "annotation", "class", "condition"]);
const IGNORED_KEYS = new Set(["index", "sample", "n", ""]);

export interface SedationIcuRecording {
  channels: string[];
  sampleRate: number;
  /** One µV series per channel, in `channels` order. */
  signals: Float64Array[];
  /** Per-sample published label, when the export carries a label column. */
  labels: (string | null)[] | null;
}

/**
 * Parse a sample-wise CSV export from either collection. Non-numeric columns
 * are never treated as EEG, so an annotation column cannot silently become a
 * dead channel.
 */
export function parseSedationIcuCsv(
  text: string,
  fallbackSampleRate: number,
): SedationIcuRecording {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) throw new Error("The recording file is empty.");
  const header = splitLine(lines[0]!).map((h) => h.toLowerCase());

  const timeIdx = header.findIndex((h) => TIME_KEYS.has(h));
  const labelIdx = header.findIndex((h) => LABEL_KEYS.has(h));
  const channelIdx: number[] = [];
  const channels: string[] = [];
  header.forEach((h, i) => {
    if (i === timeIdx || i === labelIdx || IGNORED_KEYS.has(h)) return;
    channelIdx.push(i);
    channels.push(h.toUpperCase());
  });
  if (!channels.length) throw new Error("No EEG channel columns were found.");

  const rows = lines.slice(1).map(splitLine);
  const signals = channels.map(() => new Float64Array(rows.length));
  const labels: (string | null)[] = [];
  const times: number[] = [];
  let kept = 0;

  for (const row of rows) {
    let any = false;
    channelIdx.forEach((col, c) => {
      const v = Number(row[col]);
      if (Number.isFinite(v)) {
        signals[c]![kept] = v;
        any = true;
      }
    });
    if (!any) continue;
    if (timeIdx >= 0) {
      const t = Number(row[timeIdx]);
      if (Number.isFinite(t)) times.push(t);
    }
    if (labelIdx >= 0) {
      const raw = row[labelIdx] ?? "";
      labels.push(raw ? normalisePhysionetLabel(raw) : null);
    }
    kept++;
  }
  if (!kept) throw new Error("No numeric EEG samples were found.");

  let sampleRate = fallbackSampleRate;
  if (times.length > 2) {
    const span = times[times.length - 1]! - times[0]!;
    // Millisecond clocks are common in both exports; detect and rescale.
    const seconds = span / (span > times.length * 10 ? 1000 : 1);
    if (seconds > 0) sampleRate = (times.length - 1) / seconds;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = fallbackSampleRate;

  return {
    channels,
    sampleRate: Math.round(sampleRate * 100) / 100,
    signals: signals.map((s) => s.subarray(0, kept) as Float64Array),
    labels: labelIdx >= 0 ? labels : null,
  };
}

/* ---------------------------------------------------------------- epochs --- */

export interface SedationIcuEpochOptions {
  dataset: SedationIcuDataset;
  caseRef: string;
  channel: string | null;
  epochSeconds?: number;
}

/**
 * Derive DSA epochs from one channel, then overlay the published label for the
 * epoch's own window when the export carried one. Nothing else is inferred: a
 * derived suppression verdict stays marked `derived` so validation will not
 * mistake this app's own detector output for ground truth.
 */
export function epochsFromRecording(
  recording: SedationIcuRecording,
  channelIndex: number,
  options: SedationIcuEpochOptions,
): PhysionetEpoch[] {
  const signal = recording.signals[channelIndex];
  if (!signal) return [];
  const { source } = sedationIcuLineage(options.dataset);
  const epochSeconds = options.epochSeconds ?? 4;
  const epochs = deriveEpochsFromRaw(signal, recording.sampleRate, {
    caseRef: options.caseRef,
    channel: options.channel,
    epochSeconds,
  });
  const labels = recording.labels;

  return epochs.map((e) => {
    const withRef: PhysionetEpoch = {
      ...e,
      externalRef: `${source}:${options.caseRef}:${options.channel ?? "eeg"}:${e.atSeconds.toFixed(3)}`,
    };
    if (!labels) return withRef;
    // Modal published label across the epoch's own samples.
    const start = Math.round(e.atSeconds * recording.sampleRate);
    const end = Math.min(labels.length, start + Math.round(epochSeconds * recording.sampleRate));
    const counts = new Map<string, number>();
    for (let i = start; i < end; i++) {
      const l = labels[i];
      if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    if (!counts.size) return withRef;
    const label = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    return { ...withRef, label, labelSource: "dataset" as const };
  });
}

/** Attach lineage, covariates and the harmonisation record for storage. */
export function toSedationIcuRows(
  dataset: SedationIcuDataset,
  epochs: (PhysionetEpoch & { harmonization?: HarmonizationRecord })[],
  meta: {
    datasetVersion?: string | null;
    covariates?: Record<string, string | number | null>;
  } = {},
): PhysionetImportRow[] {
  const { source, lineage } = sedationIcuLineage(dataset);
  return epochs.map((e) => ({
    ...e,
    source,
    sourceLineage: lineage,
    datasetVersion: meta.datasetVersion ?? null,
    covariates: meta.covariates ?? {},
    ...(e.harmonization ? { harmonization: e.harmonization } : {}),
  }));
}
