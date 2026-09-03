/**
 * CHB-MIT paediatric seizure collection (PhysioNet, ODC-BY 1.0).
 *
 * Each subject folder publishes hour-long EDF recordings plus one plain-text
 * `chbNN-summary.txt` listing the seizure intervals per file. This module turns
 * that pair into labelled DSA epochs on the app's own detector, keeping the
 * collection in its own lineage: paediatric bipolar recordings must never be
 * pooled into the device-specific COEBIS depth fit, only used as seizure
 * material for benchmarking and priors.
 */

import { readEdfChannel } from "./edf";
import {
  epochsFromPathologyRecording,
  toPathologyRows,
  type PathologyAnnotation,
} from "./pathology-datasets";
import type { PhysionetEpoch, PhysionetImportRow } from "./physionet";
import type { HarmonizationRecord } from "./harmonization";

/** Frontal bipolar derivations, closest to the app's AF7/AF8 montage. */
export const CHB_PREFERRED_CHANNELS = ["FP1-F7", "FP2-F8", "FP1-F3", "FP2-F4"];

export interface ChbSeizure {
  file: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Parse a `chbNN-summary.txt` into seizure intervals per recording. The format
 * repeats `File Name:` blocks, each followed by zero or more numbered
 * `Seizure [n] Start Time:` / `End Time:` lines in seconds from file start.
 */
export function parseChbSummary(text: string): ChbSeizure[] {
  const out: ChbSeizure[] = [];
  let file: string | null = null;
  let start: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const nameMatch = /^File Name:\s*(\S+)/i.exec(line);
    if (nameMatch) {
      file = nameMatch[1]!;
      start = null;
      continue;
    }
    const startMatch = /^Seizure(?:\s+\d+)?\s+Start Time:\s*([\d.]+)/i.exec(line);
    if (startMatch) {
      start = Number(startMatch[1]);
      continue;
    }
    const endMatch = /^Seizure(?:\s+\d+)?\s+End Time:\s*([\d.]+)/i.exec(line);
    if (endMatch && file && start != null) {
      const end = Number(endMatch[1]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        out.push({ file, startSeconds: start, endSeconds: end });
      }
      start = null;
    }
  }
  return out;
}

/** Seizure intervals for one recording, as pathology annotations. */
export function chbAnnotations(summary: ChbSeizure[], fileName: string): PathologyAnnotation[] {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  return summary
    .filter((s) => s.file === base)
    .map((s) => ({
      startSeconds: s.startSeconds,
      stopSeconds: s.endSeconds,
      label: "seizure",
      channel: null,
      confidence: null,
    }));
}

/** Subject identifier from a published path, e.g. "chb01/chb01_03.edf" → "chb01". */
export function chbSubject(path: string): string {
  const match = /(chb\d+)/i.exec(path);
  return match ? match[1]!.toLowerCase() : "unknown";
}

/** URL of the subject summary that labels a given recording. */
export function chbSummaryUrl(fileUrl: string): string {
  const subject = chbSubject(fileUrl);
  return fileUrl.replace(/[^/]+$/, `${subject}-summary.txt`);
}

export interface ChbParseResult {
  epochs: PhysionetEpoch[];
  channel: string;
  sampleRate: number;
  durationSeconds: number;
  seizures: number;
}

/** Decode one CHB-MIT EDF and label its epochs from the subject summary. */
export function parseChbRecording(
  bytes: Uint8Array,
  options: { caseRef: string; fileName: string; summary?: ChbSeizure[] },
): ChbParseResult {
  const decoded = readEdfChannel(bytes, CHB_PREFERRED_CHANNELS);
  const annotations = chbAnnotations(options.summary ?? [], options.fileName);
  const epochs = epochsFromPathologyRecording(decoded.signal, decoded.sampleRate, {
    dataset: "chbmit",
    caseRef: options.caseRef,
    channel: decoded.channel,
    annotations,
  });
  return {
    epochs,
    channel: decoded.channel,
    sampleRate: decoded.sampleRate,
    durationSeconds: decoded.durationSeconds,
    seizures: annotations.length,
  };
}

/** Attach lineage, version and subject covariates so a batch is ready to store. */
export function chbRows(
  epochs: (PhysionetEpoch & { harmonization?: HarmonizationRecord })[],
  meta: { datasetVersion?: string | null; subject: string; channel: string; seizures: number },
): PhysionetImportRow[] {
  return toPathologyRows("chbmit", epochs, {
    datasetVersion: meta.datasetVersion ?? null,
    covariates: {
      subject: meta.subject,
      channel: meta.channel,
      age_band: "paediatric",
      seizure_intervals: meta.seizures,
    },
  });
}
