/**
 * Pathology collections — seizure and CNS-disease EEG ingest.
 *
 * These are the open corpora that carry expert event labels this app has no
 * other way to obtain: recorded seizures, periodic discharges and clinically
 * reported abnormal/normal verdicts. They exist to sharpen the seizure and
 * pathology detectors and to give the diagnostic models a wider population —
 * they are *not* anaesthesia depth material and never enter paired COEBIS
 * alignment.
 *
 *   1. TUSZ  — TUH EEG Seizure Corpus. Expert seizure onsets/offsets with
 *      seizure type per event, 250 Hz, clinical 10-20 montage.
 *   2. CHB-MIT — paediatric scalp seizure recordings, 256 Hz, bipolar double
 *      banana, seizure intervals published per recording.
 *   3. TUAB — TUH Abnormal corpus. Whole-recording normal/abnormal verdicts
 *      from the clinical report; the broadest open CNS-disease signal.
 *   4. Helsinki neonatal — neonatal seizure recordings with three independent
 *      expert annotators, 256 Hz.
 *
 * Signals arrive as sample CSVs (one column per channel). Event labels arrive
 * as a separate annotation CSV of `start,stop,label` intervals — the shape
 * TUSZ `.csv_bi` and CHB-MIT summaries both reduce to. Labels are applied to
 * an epoch only when the event genuinely covers it, are marked `dataset`, and
 * are the only labels downstream validation treats as ground truth.
 */

import type { HarmonizationRecord, SourceMontage } from "./harmonization";
import {
  deriveEpochsFromRaw,
  type PhysionetEpoch,
  type PhysionetImportRow,
} from "./physionet";

export type PathologyDataset = "tusz" | "chbmit" | "tuab" | "neonatal" | "bdsp-dhypothermia";

export type PathologyCategory = "seizure" | "cns-disease" | "suppression";

export interface PathologyDatasetInfo {
  id: PathologyDataset;
  label: string;
  category: PathologyCategory;
  source: string;
  lineage: string;
  /** Native rate, used when the signal file carries no clock. */
  sampleRate: number;
  montage: SourceMontage;
  licence: string;
  /** What the annotation file for this collection normally contains. */
  annotations: string;
  description: string;
}

export const PATHOLOGY_DATASETS: PathologyDatasetInfo[] = [
  {
    id: "tusz",
    label: "TUH seizure corpus (TUSZ)",
    category: "seizure",
    source: "tuh-eeg-seizure",
    lineage: "external:tuh:seizure-corpus",
    sampleRate: 250,
    montage: {
      channel: "FP1",
      reference: "average",
      lowHz: 0.5,
      highHz: 45,
      sampleRateHz: 250,
      note: "Clinical 10-20 adult montage, commonly exported average-referenced (250 Hz).",
    },
    licence: "TUH EEG open data agreement (registration required, redistribution restricted)",
    annotations: "Per-event start/stop with seizure type (fnsz, gnsz, cpsz, absz, tcsz, …).",
    description:
      "Expert-marked seizure onsets and offsets in adults — the reference material for seizure onset timing and type.",
  },
  {
    id: "chbmit",
    label: "CHB-MIT paediatric seizures",
    category: "seizure",
    source: "physionet-chbmit",
    lineage: "external:physionet:chb-mit",
    sampleRate: 256,
    montage: {
      channel: "FP1-F7",
      reference: "bipolar-frontal",
      lowHz: 0.5,
      highHz: 45,
      sampleRateHz: 256,
      note: "Bipolar double-banana paediatric montage (256 Hz).",
    },
    licence: "Open Data Commons ODC-BY 1.0 (PhysioNet)",
    annotations: "Seizure intervals per recording, from the published summary files.",
    description:
      "Paediatric scalp recordings with clearly delimited seizures — useful for false-positive control at low amplitudes.",
  },
  {
    id: "tuab",
    label: "TUH abnormal corpus (TUAB)",
    category: "cns-disease",
    source: "tuh-eeg-abnormal",
    lineage: "external:tuh:abnormal-corpus",
    sampleRate: 250,
    montage: {
      channel: "FP1",
      reference: "average",
      lowHz: 0.5,
      highHz: 45,
      sampleRateHz: 250,
      note: "Clinical 10-20 adult montage, average-referenced (250 Hz).",
    },
    licence: "TUH EEG open data agreement (registration required, redistribution restricted)",
    annotations:
      "One whole-recording verdict (normal / abnormal), optionally with slowing or discharge findings.",
    description:
      "Clinically reported normal versus abnormal recordings — background material for CNS-disease discrimination.",
  },
  {
    id: "neonatal",
    label: "Helsinki neonatal seizures",
    category: "seizure",
    source: "zenodo-helsinki-neonatal",
    lineage: "external:zenodo:helsinki-neonatal",
    sampleRate: 256,
    montage: {
      channel: "FP1",
      reference: "average",
      lowHz: 0.5,
      highHz: 30,
      sampleRateHz: 256,
      note: "Neonatal 10-20 reduced montage (256 Hz).",
    },
    licence: "Creative Commons Attribution 4.0 (Zenodo)",
    annotations: "Consensus or per-annotator seizure intervals in seconds.",
    description:
      "Neonatal seizures marked by three independent experts — a hard negative set, since neonatal background differs sharply from adults.",
  },
  {
    id: "bdsp-dhypothermia",
    label: "BDSP deep-hypothermia burst suppression",
    category: "suppression",
    source: "bdsp-dhypothermia",
    lineage: "external:bdsp:dhypothermia",
    sampleRate: 250,
    montage: {
      channel: "FP1",
      reference: "average",
      lowHz: 0.5,
      highHz: 45,
      sampleRateHz: 250,
      note: "Clinical scalp 10-20 EEG recorded through cardiac-surgery cooling; convert to CSV samples before upload.",
    },
    licence: "BDSP open-access tier (free BDSP account required; no redistribution)",
    annotations:
      "Expert-reviewed burst/suppression intervals — start,stop,label rows (burst_suppression / suppression / burst / continuous).",
    description:
      "Real burst suppression from deep-hypothermic circulatory arrest — a non-anaesthetic ground truth that keeps the suppression model honest beyond propofol-shaped suppression.",
  },
];

export function pathologyDataset(id: PathologyDataset): PathologyDatasetInfo {
  const found = PATHOLOGY_DATASETS.find((d) => d.id === id);
  if (!found) throw new Error(`Unknown pathology dataset: ${id}`);
  return found;
}

/* ------------------------------------------------------------- labels --- */

/**
 * Normalise the label vocabularies these corpora use into one set. TUSZ event
 * codes, plain English annotations and clinical report verdicts all land on
 * the same names so downstream grouping does not fragment.
 */
export function normalisePathologyLabel(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!v) return null;
  if (/^(bckg|bg|background|non_?seizure|no_?seizure|interictal)$/.test(v)) return "background";
  if (/^(fnsz|focal_?seizure)$/.test(v)) return "focal_seizure";
  if (/^(spsz|simple_?partial)/.test(v)) return "focal_aware_seizure";
  if (/^(cpsz|complex_?partial)/.test(v)) return "focal_impaired_awareness_seizure";
  if (/^(absz|absence)/.test(v)) return "absence_seizure";
  if (/^(mysz|myoclonic)/.test(v)) return "myoclonic_seizure";
  if (/^(tcsz|tonic_?clonic|gtcs)/.test(v)) return "tonic_clonic_seizure";
  if (/^(tnsz|tonic_?seizure)/.test(v)) return "tonic_seizure";
  if (/^(gnsz|generali[sz]ed)/.test(v)) return "generalised_seizure";
  if (/(seiz|^sz$|ictal)/.test(v)) return "seizure";
  if (/(spsw|spike|sharp)/.test(v)) return "epileptiform_discharge";
  if (/(pled|lpd)/.test(v)) return "lateralised_periodic_discharges";
  if (/(gped|gpd)/.test(v)) return "generalised_periodic_discharges";
  if (/slow/.test(v)) return "slowing";
  if (/(artf|artifact|artefact|musc|elec|eyem|chew|shiv)/.test(v)) return "artifact";
  if (/^(abnorm)/.test(v)) return "abnormal";
  if (/^(norm)/.test(v)) return "normal";
  if (/(burst.*suppress|^bs$|^bsr$)/.test(v)) return "burst_suppression";
  if (/^suppress(ed|ion|ive)/.test(v)) return "suppression";
  if (/^burst/.test(v)) return "burst";
  if (/^(continuous|cont_?eeg)$/.test(v)) return "continuous";
  return v;
}

const SEIZURE_LABELS = /seizure|^seizure$/;

/** Is this label an actual recorded seizure, rather than a discharge or background? */
export function isSeizureLabel(label: string | null | undefined): boolean {
  return Boolean(label && SEIZURE_LABELS.test(label));
}

/* --------------------------------------------------------- annotations --- */

export interface PathologyAnnotation {
  /** Null when the event applies to every channel. */
  channel: string | null;
  startSeconds: number;
  stopSeconds: number;
  label: string;
  confidence: number | null;
}

function splitLine(line: string): string[] {
  return line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ""));
}

const START_KEYS = ["start_time", "start", "onset", "begin", "start_s"];
const STOP_KEYS = ["stop_time", "stop", "end", "offset", "end_s", "stop_s"];
const LABEL_KEYS = ["label", "event", "type", "class", "annotation", "seizure_type"];
const CHANNEL_KEYS = ["channel", "chan", "montage", "electrode"];
const CONF_KEYS = ["confidence", "probability", "conf"];

function indexOfAny(header: string[], keys: string[]): number {
  for (const k of keys) {
    const i = header.indexOf(k);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse an interval annotation file. Handles the TUSZ `.csv_bi` shape
 * (`channel,start_time,stop_time,label,confidence`, `#` comment preamble) and
 * the simpler `start,stop,label` summaries CHB-MIT and Zenodo exports use.
 * A whole-recording verdict is accepted as a single row with no times.
 */
export function parsePathologyAnnotations(
  text: string,
  options: { totalSeconds?: number } = {},
): PathologyAnnotation[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!lines.length) return [];
  const header = splitLine(lines[0]!).map((h) => h.toLowerCase());

  const startIdx = indexOfAny(header, START_KEYS);
  const stopIdx = indexOfAny(header, STOP_KEYS);
  const labelIdx = indexOfAny(header, LABEL_KEYS);
  if (labelIdx < 0) throw new Error("The annotation file has no label column.");

  const channelIdx = indexOfAny(header, CHANNEL_KEYS);
  const confIdx = indexOfAny(header, CONF_KEYS);
  const out: PathologyAnnotation[] = [];

  for (const line of lines.slice(1)) {
    const row = splitLine(line);
    const label = normalisePathologyLabel(row[labelIdx] ?? "");
    if (!label) continue;

    const start = startIdx >= 0 ? Number(row[startIdx]) : 0;
    const stop = stopIdx >= 0 ? Number(row[stopIdx]) : Number.NaN;
    const startSeconds = Number.isFinite(start) ? start : 0;
    // A verdict row with no interval covers the whole recording.
    const stopSeconds = Number.isFinite(stop)
      ? stop
      : (options.totalSeconds ?? Number.POSITIVE_INFINITY);
    if (stopSeconds <= startSeconds) continue;

    const channel = channelIdx >= 0 ? (row[channelIdx] ?? "").trim() : "";
    const conf = confIdx >= 0 ? Number(row[confIdx]) : Number.NaN;

    out.push({
      channel: channel && !/^(all|any|-)$/i.test(channel) ? channel.toUpperCase() : null,
      startSeconds,
      stopSeconds,
      label,
      confidence: Number.isFinite(conf) ? conf : null,
    });
  }

  return out.sort((a, b) => a.startSeconds - b.startSeconds);
}

/** How much of `[from, to)` an annotation covers, as a fraction of the epoch. */
function overlapFraction(
  ann: PathologyAnnotation,
  from: number,
  to: number,
): number {
  const span = to - from;
  if (span <= 0) return 0;
  const covered = Math.min(to, ann.stopSeconds) - Math.max(from, ann.startSeconds);
  return covered > 0 ? covered / span : 0;
}

export interface AnnotationApplyOptions {
  /** Only channel-specific events matching this channel are considered. */
  channel?: string | null;
  /** Fraction of the epoch an event must cover to label it. Default 0.5. */
  minOverlap?: number;
}

/**
 * Overlay interval annotations onto derived epochs. An event must cover at
 * least `minOverlap` of the epoch, so a seizure that clips one corner of a
 * window does not mark the whole window ictal. Where several events qualify,
 * the one covering most of the epoch wins, and a genuine seizure outranks a
 * background row covering the same time.
 */
export function applyAnnotations(
  epochs: PhysionetEpoch[],
  annotations: PathologyAnnotation[],
  options: AnnotationApplyOptions = {},
): PhysionetEpoch[] {
  if (!annotations.length) return epochs;
  const minOverlap = options.minOverlap ?? 0.5;
  const channel = options.channel ? options.channel.toUpperCase() : null;
  const relevant = annotations.filter(
    (a) => !a.channel || !channel || a.channel === channel,
  );
  if (!relevant.length) return epochs;

  return epochs.map((e) => {
    const from = e.atSeconds;
    const to = e.atSeconds + e.epochSeconds;
    let best: { label: string; score: number } | null = null;

    for (const ann of relevant) {
      if (ann.startSeconds >= to) break;
      const fraction = overlapFraction(ann, from, to);
      if (fraction < minOverlap) continue;
      // Seizures win ties against background rows spanning the same seconds.
      const score = fraction + (isSeizureLabel(ann.label) ? 1 : 0);
      if (!best || score > best.score) best = { label: ann.label, score };
    }

    return best ? { ...e, label: best.label, labelSource: "dataset" as const } : e;
  });
}

/* -------------------------------------------------------------- epochs --- */

export interface PathologyEpochOptions {
  dataset: PathologyDataset;
  caseRef: string;
  channel: string | null;
  epochSeconds?: number;
  annotations?: PathologyAnnotation[];
  minOverlap?: number;
}

/**
 * Derive DSA epochs from one channel of a pathology recording and label them
 * from the annotation intervals. Features come from the same detector the
 * bedside pipeline uses, so an imported epoch is directly comparable with a
 * live one.
 */
export function epochsFromPathologyRecording(
  signal: Float64Array,
  sampleRate: number,
  options: PathologyEpochOptions,
): PhysionetEpoch[] {
  const info = pathologyDataset(options.dataset);
  const epochSeconds = options.epochSeconds ?? 4;
  const derived = deriveEpochsFromRaw(signal, sampleRate, {
    caseRef: options.caseRef,
    channel: options.channel,
    epochSeconds,
  }).map((e) => ({
    ...e,
    externalRef: `${info.source}:${options.caseRef}:${options.channel ?? "eeg"}:${e.atSeconds.toFixed(3)}`,
  }));

  const opts: AnnotationApplyOptions = {
    channel: options.channel ?? null,
    ...(options.minOverlap != null ? { minOverlap: options.minOverlap } : {}),
  };
  return applyAnnotations(derived, options.annotations ?? [], opts);
}

/** Attach lineage, dataset version and covariates so a batch is ready to store. */
export function toPathologyRows(
  dataset: PathologyDataset,
  epochs: (PhysionetEpoch & { harmonization?: HarmonizationRecord })[],
  meta: {
    datasetVersion?: string | null;
    covariates?: Record<string, string | number | null>;
  } = {},
): PhysionetImportRow[] {
  const info = pathologyDataset(dataset);
  return epochs.map((e) => ({
    ...e,
    source: info.source,
    sourceLineage: info.lineage,
    datasetVersion: meta.datasetVersion ?? null,
    covariates: {
      pathology_category: info.category,
      dataset_licence: info.licence,
      ...(meta.covariates ?? {}),
    },
    ...(e.harmonization ? { harmonization: e.harmonization } : {}),
  }));
}

export interface PathologyLabelSummary {
  epochs: number;
  labelled: number;
  seizureEpochs: number;
  labels: { label: string; count: number }[];
}

/** Label mix of a parsed batch, for the confirmation the panel shows. */
export function summarisePathologyLabels(epochs: PhysionetEpoch[]): PathologyLabelSummary {
  const counts = new Map<string, number>();
  let labelled = 0;
  let seizures = 0;
  for (const e of epochs) {
    if (e.labelSource !== "dataset" || !e.label) continue;
    labelled++;
    if (isSeizureLabel(e.label)) seizures++;
    counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
  }
  return {
    epochs: epochs.length,
    labelled,
    seizureEpochs: seizures,
    labels: [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}
