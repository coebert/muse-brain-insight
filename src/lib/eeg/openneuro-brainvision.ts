/**
 * OpenNeuro ds005620 — "A repeated awakening study exploring the capacity of
 * complexity measures to capture dreaming during propofol sedation" (CC-BY-4.0).
 *
 * The record is BIDS-organised but published in BrainVision format rather than
 * EDF: a text `.vhdr` header beside a raw `.eeg` binary. There is no bedside
 * depth index in this collection — the published reference is the recording
 * condition itself, carried in the BIDS `task-` entity (`awake` for
 * wakefulness, `sed`/`sed2` during propofol sedation). That is a coarser label
 * than a monitor trace, so these epochs are stored under their own lineage and
 * are only ever used for depth-state grading and tier-level priors, never for
 * the device-specific COEBIS fit.
 */

import type { HarmonizationRecord, SourceMontage } from "./harmonization";
import {
  deriveEpochsFromRaw,
  normalisePhysionetLabel,
  type PhysionetEpoch,
  type PhysionetImportRow,
} from "./physionet";
import { parseBidsName } from "./openneuro";

export const OPENNEURO_DS005620_SOURCE = "openneuro-ds005620";
export const OPENNEURO_DS005620_LINEAGE = "external:openneuro:ds005620";

/** Frontal electrodes, closest to the app's forehead derivation. */
export const BRAINVISION_PREFERRED_CHANNELS = [
  "AF3",
  "AF4",
  "AF7",
  "AF8",
  "Fp1",
  "Fp2",
  "Fpz",
  "F7",
  "F8",
  "Fz",
];

export const OPENNEURO_DS005620_MONTAGE: SourceMontage = {
  channel: "Fp1",
  reference: "average",
  lowHz: 0,
  highHz: 250,
  sampleRateHz: 500,
  note: "65-channel BrainVision cap, frontal channel decoded, average reference.",
};

/* -------------------------------------------------------------- header --- */

export interface BrainVisionChannel {
  label: string;
  /** Multiplier from stored units to microvolts. */
  resolutionUv: number;
}

export interface BrainVisionHeader {
  dataFile: string | null;
  sampleRate: number;
  channels: BrainVisionChannel[];
  format: "int16" | "int32" | "float32";
  multiplexed: boolean;
}

const FORMATS: Record<string, BrainVisionHeader["format"]> = {
  int_16: "int16",
  int_32: "int32",
  ieee_float_32: "float32",
};

/** Bytes per stored sample for each supported BrainVision binary format. */
export function sampleWidth(format: BrainVisionHeader["format"]): number {
  return format === "int16" ? 2 : 4;
}

/**
 * Parse a BrainVision `.vhdr`. It is an INI file: `[Common Infos]` carries the
 * sampling interval in microseconds, `[Binary Infos]` the storage format and
 * `[Channel Infos]` one `Ch<n>=<label>,<ref>,<resolution>,<unit>` per channel.
 */
export function parseBrainVisionHeader(text: string): BrainVisionHeader {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let section = "";
  let dataFile: string | null = null;
  let samplingIntervalUs: number | null = null;
  let format: BrainVisionHeader["format"] = "int16";
  let multiplexed = true;
  const channels: BrainVisionChannel[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const heading = /^\[(.+)\]$/.exec(line);
    if (heading) {
      section = heading[1]!.trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();

    if (section === "common infos") {
      if (key === "datafile") dataFile = value;
      else if (key === "samplinginterval") samplingIntervalUs = Number(value);
      else if (key === "dataorientation") multiplexed = !/vectorized/i.test(value);
      else if (key === "dataformat" && /ascii/i.test(value)) {
        throw new Error("ASCII BrainVision recordings are not supported");
      }
    } else if (section === "binary infos" && key === "binaryformat") {
      const mapped = FORMATS[value.trim().toLowerCase()];
      if (!mapped) throw new Error(`unsupported BrainVision format ${value}`);
      format = mapped;
    } else if (section === "channel infos" && /^ch\d+$/.test(key)) {
      const cells = value.split(",");
      const label = (cells[0] ?? "").trim();
      const resolution = Number(cells[2]);
      if (!label) continue;
      channels.push({
        label,
        resolutionUv: Number.isFinite(resolution) && resolution > 0 ? resolution : 1,
      });
    }
  }

  if (!channels.length) throw new Error("the header lists no channels");
  if (!samplingIntervalUs || !Number.isFinite(samplingIntervalUs) || samplingIntervalUs <= 0) {
    throw new Error("the header carries no sampling interval");
  }
  return {
    dataFile,
    sampleRate: Math.round(1_000_000 / samplingIntervalUs),
    channels,
    format,
    multiplexed,
  };
}

/** URL of the `.vhdr` header that sits beside a given `_eeg.eeg`. */
export function headerUrlFor(eegUrl: string): string {
  const [base, query = ""] = eegUrl.split("?");
  const swapped = (base ?? eegUrl).replace(/\.eeg$/i, ".vhdr");
  return swapped === base ? `${swapped}${query ? `?${query}` : ""}` : swapped;
}

/** Pick the frontal channel this app can compare against, else the first one. */
export function pickBrainVisionChannel(
  channels: BrainVisionChannel[],
  preferred: string[] = BRAINVISION_PREFERRED_CHANNELS,
): number {
  for (const want of preferred) {
    const idx = channels.findIndex((c) => c.label.trim().toLowerCase() === want.toLowerCase());
    if (idx >= 0) return idx;
  }
  return 0;
}

/* ------------------------------------------------------------- decoding --- */

export interface DecodedBrainVision {
  signal: Float64Array;
  channel: string;
  sampleRate: number;
  durationSeconds: number;
}

/**
 * Read one channel out of a BrainVision binary. A byte-range prefix is a valid
 * input: whole samples are decoded and any trailing partial frame is dropped.
 */
export function readBrainVisionChannel(
  bytes: Uint8Array,
  header: BrainVisionHeader,
  preferred: string[] = BRAINVISION_PREFERRED_CHANNELS,
): DecodedBrainVision {
  const index = pickBrainVisionChannel(header.channels, preferred);
  const channel = header.channels[index]!;
  const width = sampleWidth(header.format);
  const count = header.channels.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const readAt = (offset: number): number => {
    if (header.format === "int16") return view.getInt16(offset, true);
    if (header.format === "int32") return view.getInt32(offset, true);
    return view.getFloat32(offset, true);
  };

  let out: Float64Array;
  if (header.multiplexed) {
    const frames = Math.floor(bytes.byteLength / (width * count));
    if (frames < header.sampleRate) throw new Error("too little signal to derive an epoch");
    out = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      out[f] = readAt((f * count + index) * width) * channel.resolutionUv;
    }
  } else {
    // Vectorised files store each channel end to end; a prefix only reaches the
    // first channels, so this path is limited to whole downloads.
    const perChannel = Math.floor(bytes.byteLength / (width * count));
    if (perChannel < header.sampleRate) throw new Error("too little signal to derive an epoch");
    out = new Float64Array(perChannel);
    const base = index * perChannel * width;
    for (let s = 0; s < perChannel; s++) out[s] = readAt(base + s * width) * channel.resolutionUv;
  }

  return {
    signal: out,
    channel: channel.label.trim(),
    sampleRate: header.sampleRate,
    durationSeconds: out.length / header.sampleRate,
  };
}

/* -------------------------------------------------------------- labels --- */

/**
 * The published depth reference for this record is the recording condition.
 * `awake` is wakefulness before induction; `sed` and `sed2` are recorded under
 * propofol sedation, `sed2` in the minute before a scripted awakening.
 */
export function stateForTask(task: string | null): string | null {
  if (!task) return null;
  const v = task.toLowerCase();
  if (v.startsWith("awake")) return "awake";
  if (v.startsWith("sed")) return "sedated";
  return null;
}

/* ------------------------------------------------------------- parsing --- */

export interface BrainVisionParseResult {
  epochs: PhysionetEpoch[];
  channel: string;
  sampleRate: number;
  durationSeconds: number;
  /** The condition label every epoch carries, when the filename declares one. */
  state: string | null;
}

/** Case reference is one recording condition for one subject. */
export function brainVisionCaseRef(path: string): string {
  const { subject, session, task } = parseBidsName(path);
  return [subject, session, task ? `task-${task}` : null].filter(Boolean).join("_");
}

/** Decode one ds005620 recording into labelled DSA epochs. */
export function parseBrainVisionRecording(
  bytes: Uint8Array,
  header: BrainVisionHeader,
  options: { caseRef: string; fileName: string },
): BrainVisionParseResult {
  const decoded = readBrainVisionChannel(bytes, header);
  const raw = deriveEpochsFromRaw(decoded.signal, decoded.sampleRate, {
    caseRef: options.caseRef,
    channel: decoded.channel,
  });
  if (!raw.length) throw new Error("no usable epochs were derived");

  const { task } = parseBidsName(options.fileName);
  const state = stateForTask(task);
  const label = state ? (normalisePhysionetLabel(state) ?? state) : null;

  const epochs = raw.map((e) => ({
    ...e,
    label: label ?? e.label,
    labelSource: (label ? "dataset" : e.labelSource) as PhysionetEpoch["labelSource"],
    externalRef: `${OPENNEURO_DS005620_SOURCE}:${options.caseRef}:${decoded.channel}:${e.atSeconds.toFixed(3)}`,
  }));

  return {
    epochs,
    channel: decoded.channel,
    sampleRate: decoded.sampleRate,
    durationSeconds: decoded.durationSeconds,
    state: label,
  };
}

/** Attach lineage, version and covariates so a batch is ready to store. */
export function brainVisionRows(
  epochs: (PhysionetEpoch & { harmonization?: HarmonizationRecord })[],
  meta: {
    datasetVersion?: string | null;
    fileName: string;
    channel: string;
    state: string | null;
  },
): PhysionetImportRow[] {
  const { subject, session, task } = parseBidsName(meta.fileName);
  return epochs.map((e) => ({
    ...e,
    source: OPENNEURO_DS005620_SOURCE,
    sourceLineage: OPENNEURO_DS005620_LINEAGE,
    datasetVersion: meta.datasetVersion ?? null,
    covariates: {
      subject,
      session,
      task: task ?? null,
      channel: meta.channel,
      setting: "propofol_sedation",
      regimen: "propofol",
      published_state: meta.state,
    },
    ...(e.harmonization ? { harmonization: e.harmonization } : {}),
  }));
}
