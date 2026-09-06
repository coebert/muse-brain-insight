/**
 * Manual intake for corpora that cannot be fetched automatically.
 *
 * BDSP needs a signed-in account, BOAS ships as a night-per-file archive and
 * the OpenNeuro sleep records are large BIDS trees. In each case the clinician
 * downloads the files themselves and uploads one recording at a time here.
 *
 * The rules that govern the automated scan apply unchanged:
 *   1. every source keeps its own lineage, so an uploaded night can never be
 *      pooled into the device-specific COEBIS fit;
 *   2. labels come from the uploaded annotation file, never from the model
 *      being graded — with no annotation file the epochs are stored unlabelled;
 *   3. montage, reference and sample rate are recorded and harmonised, so the
 *      transform applied to each epoch stays auditable.
 */

import { readEdfChannel } from "./edf";
import { harmonizeEpochs } from "./harmonization";
import type { SourceMontage } from "./harmonization";
import { applyAnnotations, type PathologyAnnotation } from "./pathology-datasets";
import {
  deriveEpochsFromRaw,
  normalisePhysionetLabel,
  type PhysionetImportRow,
} from "./physionet";

export const CORPUS_UPLOAD_VERSION = "corpus-upload-1.0.0";

/** How an annotation file's labels should be read. */
export type LabelStyle = "suppression" | "sleep" | "state";

export interface UploadPreset {
  id: string;
  label: string;
  /** Plain description of what the clinician is uploading. */
  blurb: string;
  lineage: string;
  licence: string;
  licenceUrl: string;
  homepage: string;
  /** How the files are obtained, shown as the access note on the page. */
  access: string;
  /** Frontal-first channel preference for the decoded derivation. */
  preferredChannels: string[];
  montage: SourceMontage;
  labelStyle: LabelStyle;
  /** What the model layer may use this corpus for. */
  use: string;
  setting: string;
}

/** The three manually-obtained collections this page accepts. */
export const UPLOAD_PRESETS: UploadPreset[] = [
  {
    id: "bdsp-hypothermia",
    label: "BDSP — burst suppression in deep hypothermia",
    blurb:
      "Cardiac-surgery cooling recordings in which burst suppression is driven by temperature rather than drug. A second ground truth for the suppression model, from a completely different cause.",
    lineage: "external:bdsp:hypothermia",
    licence: "BDSP open access, account required",
    licenceUrl: "https://bdsp.io",
    homepage: "https://bdsp.io",
    access:
      "Sign in to BDSP with your own account, download the EDF for one recording, then upload it here.",
    preferredChannels: ["Fp1", "Fp2", "Fpz", "AF3", "AF4", "F7", "F8", "Fz"],
    montage: {
      channel: "Fp1",
      reference: "average",
      lowHz: 0.5,
      highHz: 60,
      sampleRateHz: 200,
      note: "Clinical 10/20 cap recorded during cardiopulmonary bypass cooling.",
    },
    labelStyle: "suppression",
    use: "Suppression priors and detector grading only.",
    setting: "cardiac_surgery_hypothermia",
  },
  {
    id: "boas",
    label: "BOAS — headband EEG beside clinical sleep study",
    blurb:
      "Nights recorded on a forehead headband at the same time as a full clinical sleep study, so the headband's own signal can be graded against the clinical montage.",
    lineage: "external:bitbrain:boas",
    licence: "Open access (see record)",
    licenceUrl: "https://openneuro.org/datasets/ds005555",
    homepage: "https://openneuro.org/datasets/ds005555",
    access:
      "Download one night's EDF and its sleep-stage file from the record, then upload both here.",
    preferredChannels: ["AF7", "AF8", "Fp1", "Fp2", "Fpz", "F7", "F8"],
    montage: {
      channel: "AF7",
      reference: "mastoid",
      lowHz: 0.5,
      highHz: 45,
      sampleRateHz: 256,
      note: "Forehead headband recorded alongside a clinical polysomnogram.",
    },
    labelStyle: "sleep",
    use: "Headband-versus-clinical validation and frontal-montage harmonisation.",
    setting: "sleep",
  },
  {
    id: "openneuro-sleep",
    label: "OpenNeuro sleep records (forehead montage)",
    blurb:
      "Frontal-patch and headband sleep records published on OpenNeuro. The closest montage to this app's own forehead derivation.",
    lineage: "external:openneuro:sleep",
    licence: "CC0",
    licenceUrl: "https://openneuro.org",
    homepage: "https://openneuro.org",
    access:
      "Download the recording's EDF (and its events file, if it publishes one) from the OpenNeuro record and upload them here.",
    preferredChannels: ["AF7", "AF8", "Fp1", "Fp2", "Fpz", "AF3", "AF4", "F7", "F8"],
    montage: {
      channel: "Fp1",
      reference: "linked-ears",
      lowHz: 0.3,
      highHz: 45,
      sampleRateHz: 250,
      note: "Frontal patch or headband record, BIDS-organised.",
    },
    labelStyle: "sleep",
    use: "Frontal-montage harmonisation and depth-state grading; never the device fit.",
    setting: "sleep",
  },
];

export function uploadPreset(id: string): UploadPreset {
  const found = UPLOAD_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown corpus: ${id}`);
  return found;
}

/* ---------------------------------------------------------------- labels --- */

/** Sleep stage names, kept distinct from anaesthetic depth states. */
function normaliseSleepLabel(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!v) return null;
  if (/^(w|wake|awake|sleep_stage_w)$/.test(v)) return "awake";
  if (/(^|_)(n1|s1|stage_?1)($|_)/.test(v)) return "sleep_n1";
  if (/(^|_)(n2|s2|stage_?2)($|_)/.test(v)) return "sleep_n2";
  if (/(^|_)(n3|n4|s3|s4|sws|deep|stage_?[34])($|_)/.test(v)) return "sleep_n3";
  if (/rem/.test(v)) return "sleep_rem";
  if (/(movement|artifact|artefact|unscored|\?)/.test(v)) return null;
  return normalisePhysionetLabel(v);
}

export function normaliseUploadLabel(raw: string, style: LabelStyle): string | null {
  if (style === "sleep") return normaliseSleepLabel(raw);
  return normalisePhysionetLabel(raw);
}

const START_KEYS = ["onset", "start", "start_time", "start_seconds", "begin", "time"];
const STOP_KEYS = ["stop", "end", "stop_time", "end_time", "offset"];
const DURATION_KEYS = ["duration", "length", "dur", "duration_seconds"];
const LABEL_KEYS = [
  "label",
  "trial_type",
  "stage",
  "sleep_stage",
  "annotation",
  "event",
  "description",
  "value",
  "state",
];

function splitRow(line: string): string[] {
  const delim = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
  return line.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""));
}

function indexOfAny(header: string[], keys: string[]): number {
  for (const key of keys) {
    const i = header.indexOf(key);
    if (i >= 0) return i;
  }
  return -1;
}

export interface UploadAnnotationParse {
  annotations: PathologyAnnotation[];
  rows: number;
  skipped: number;
  labels: { label: string; count: number }[];
}

/**
 * Read a sleep-stage or burst-suppression annotation file. Accepts BIDS
 * `events.tsv` (onset/duration/trial_type) and plain start/stop tables.
 */
export function parseUploadAnnotations(
  text: string,
  style: LabelStyle,
  options: { defaultDurationSeconds?: number } = {},
): UploadAnnotationParse {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!lines.length) throw new Error("The annotation file is empty.");
  const header = splitRow(lines[0]!).map((h) => h.toLowerCase());

  const startIdx = indexOfAny(header, START_KEYS);
  const stopIdx = indexOfAny(header, STOP_KEYS);
  const durIdx = indexOfAny(header, DURATION_KEYS);
  const labelIdx = indexOfAny(header, LABEL_KEYS);
  if (labelIdx < 0) throw new Error("The annotation file has no label column.");
  if (startIdx < 0) throw new Error("The annotation file has no onset or start column.");

  const annotations: PathologyAnnotation[] = [];
  const counts = new Map<string, number>();
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const row = splitRow(line);
    const label = normaliseUploadLabel(row[labelIdx] ?? "", style);
    const start = Number(row[startIdx]);
    if (!label || !Number.isFinite(start)) {
      skipped++;
      continue;
    }
    let stop = stopIdx >= 0 ? Number(row[stopIdx]) : NaN;
    if (!Number.isFinite(stop)) {
      const dur = durIdx >= 0 ? Number(row[durIdx]) : NaN;
      stop = start + (Number.isFinite(dur) && dur > 0 ? dur : options.defaultDurationSeconds ?? 30);
    }
    if (stop <= start) {
      skipped++;
      continue;
    }
    annotations.push({ channel: null, startSeconds: start, stopSeconds: stop, label, confidence: null });
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  annotations.sort((a, b) => a.startSeconds - b.startSeconds);
  return {
    annotations,
    rows: lines.length - 1,
    skipped,
    labels: [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/* ---------------------------------------------------------------- parsing --- */

export interface UploadParseResult {
  rows: PhysionetImportRow[];
  channel: string;
  sampleRate: number;
  durationSeconds: number;
  labelledEpochs: number;
  suppressedEpochs: number;
  labels: { label: string; count: number }[];
}

/** Turn a case reference out of the uploaded file name. */
export function uploadCaseRef(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const bids = /sub-[A-Za-z0-9]+(?:_ses-[A-Za-z0-9]+)?/.exec(base);
  return (bids?.[0] ?? base).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "recording";
}

/**
 * Decode one uploaded EDF into harmonised spectral epochs, label them from the
 * uploaded annotation file when one is supplied, and attach lineage and
 * provenance so the batch is ready to file.
 */
export function parseUploadedRecording(
  bytes: Uint8Array,
  options: {
    preset: UploadPreset;
    fileName: string;
    caseRef?: string;
    annotations?: PathologyAnnotation[];
    epochSeconds?: number;
  },
): UploadParseResult {
  const { preset } = options;
  const caseRef = options.caseRef?.trim() || uploadCaseRef(options.fileName);
  const decoded = readEdfChannel(bytes, preset.preferredChannels);
  const raw = deriveEpochsFromRaw(decoded.signal, decoded.sampleRate, {
    caseRef,
    channel: decoded.channel,
    ...(options.epochSeconds ? { epochSeconds: options.epochSeconds, hopSeconds: options.epochSeconds } : {}),
  });
  if (!raw.length) throw new Error("No usable epochs could be derived from this file.");

  const annotations = options.annotations ?? [];
  const labelled = annotations.length
    ? applyAnnotations(raw, annotations, { channel: decoded.channel })
    : raw;

  const harmonised = harmonizeEpochs(labelled, {
    ...preset.montage,
    channel: decoded.channel,
    sampleRateHz: decoded.sampleRate,
  });

  const counts = new Map<string, number>();
  for (const e of harmonised) if (e.label) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);

  const rows: PhysionetImportRow[] = harmonised.map((e) => ({
    ...e,
    labelSource: e.label ? ("dataset" as const) : e.labelSource,
    externalRef: `${preset.id}:${caseRef}:${decoded.channel}:${e.atSeconds.toFixed(3)}`,
    source: preset.id,
    sourceLineage: preset.lineage,
    datasetVersion: null,
    covariates: {
      subject: caseRef,
      channel: decoded.channel,
      setting: preset.setting,
      upload_version: CORPUS_UPLOAD_VERSION,
      file_name: options.fileName,
      licence: preset.licence,
      labelled_intervals: annotations.length,
    },
  }));

  return {
    rows,
    channel: decoded.channel,
    sampleRate: decoded.sampleRate,
    durationSeconds: decoded.durationSeconds,
    labelledEpochs: harmonised.filter((e) => e.label).length,
    suppressedEpochs: harmonised.filter((e) => e.isSuppressed).length,
    labels: [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}
