/**
 * OpenNeuro ds004541 — "Multimodal EEG-fNIRS data from patients undergoing
 * general anesthesia" (CC0).
 *
 * The record is BIDS-organised: each subject/session publishes one continuous
 * 58-channel EDF at 1000 Hz for the whole anaesthetic, plus an `events.tsv`
 * marking baseline, induction, loss of consciousness and return of
 * consciousness. There is no bedside depth-index export in this record, so the
 * events file is the only published depth reference; if a future revision (or
 * a sibling BIDS record reusing this parser) carries a BIS channel inside the
 * EDF, `OPENNEURO_MONITOR_CHANNELS` picks it up and it is stored as a monitor
 * reading rather than being invented here.
 *
 * The collection keeps its own lineage. It is a clinical 10/20 recording from
 * a different amplifier, so it may inform tier-level priors and per-lineage
 * benchmarking, never the device-specific COEBIS fit.
 */

import type { HarmonizationRecord, SourceMontage } from "./harmonization";
import { readEdfChannel, parseEdfHeader, pickEdfChannel } from "./edf";
import {
  deriveEpochsFromRaw,
  normalisePhysionetLabel,
  type PhysionetEpoch,
  type PhysionetImportRow,
} from "./physionet";
import { applyAnnotations, type PathologyAnnotation } from "./pathology-datasets";

export const OPENNEURO_DS004541_SOURCE = "openneuro-ds004541";
export const OPENNEURO_DS004541_LINEAGE = "external:openneuro:ds004541";

/** Frontal electrodes, closest to the app's AF7/AF8 forehead derivation. */
export const OPENNEURO_PREFERRED_CHANNELS = ["AF3", "AF4", "Fp1", "Fp2", "Fpz", "F7", "F8", "Fz"];

/** Channel labels a bedside depth monitor would be exported under, if present. */
export const OPENNEURO_MONITOR_CHANNELS = ["BIS", "BIS_INDEX", "SEF", "SR"];

export const OPENNEURO_DS004541_MONTAGE: SourceMontage = {
  channel: "AF3",
  reference: "average",
  lowHz: 0,
  highHz: 500,
  sampleRateHz: 1000,
  note: "Extended 10/20 clinical cap, 58 channels at 1000 Hz, average reference.",
};

/* --------------------------------------------------------------- names --- */

export interface BidsName {
  subject: string;
  session: string | null;
  task: string | null;
}

/** Pull subject/session/task out of a BIDS path or filename. */
export function parseBidsName(path: string): BidsName {
  const sub = /sub-([A-Za-z0-9]+)/.exec(path);
  const ses = /ses-([A-Za-z0-9]+)/.exec(path);
  const task = /task-([A-Za-z0-9]+)/.exec(path);
  return {
    subject: sub ? `sub-${sub[1]}` : "unknown",
    session: ses ? `ses-${ses[1]}` : null,
    task: task ? task[1]! : null,
  };
}

/** URL of the `events.tsv` that sits beside a given `_eeg.edf`. */
export function eventsUrlFor(eegUrl: string): string {
  const [base, query = ""] = eegUrl.split("?");
  const swapped = (base ?? eegUrl).replace(/_eeg\.edf$/i, "_events.tsv");
  // S3 version ids belong to the EDF object, so ask for the current events file.
  return swapped === base ? `${swapped}${query ? `?${query}` : ""}` : swapped;
}

/* -------------------------------------------------------------- events --- */

export interface BidsEvent {
  onsetSeconds: number;
  durationSeconds: number;
  trialType: string;
}

/** Parse a BIDS `events.tsv` (onset / duration / trial_type columns). */
export function parseBidsEvents(text: string): BidsEvent[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const header = lines[0]!.split("\t").map((h) => h.trim().toLowerCase());
  const iOnset = header.indexOf("onset");
  const iDuration = header.indexOf("duration");
  const iType = header.findIndex((h) => h === "trial_type" || h === "value" || h === "type");
  if (iOnset < 0 || iType < 0) return [];

  const out: BidsEvent[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const onset = Number(cells[iOnset]);
    const duration = iDuration >= 0 ? Number(cells[iDuration]) : 0;
    const trialType = (cells[iType] ?? "").trim();
    if (!Number.isFinite(onset) || !trialType) continue;
    out.push({
      onsetSeconds: onset,
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      trialType,
    });
  }
  return out.sort((a, b) => a.onsetSeconds - b.onsetSeconds);
}

/** Canonical consciousness state each anaesthetic marker opens. */
function stateFor(trialType: string): string | null {
  const v = trialType.toLowerCase();
  if (/^baseline/.test(v)) return "awake";
  if (/^start|induction/.test(v)) return "induction";
  if (/^loc\b/.test(v)) return "anaesthetised";
  if (/^roc\b/.test(v)) return "emergence";
  if (/^end\b/.test(v)) return "anaesthetised";
  return null;
}

/**
 * Turn instantaneous BIDS markers into the state intervals they open. Each
 * state runs until the next state-changing marker (or the end of the record),
 * which is how the published protocol describes the anaesthetic. Stimulus
 * markers (verbal, motor, tetanic) do not change state and are ignored here.
 */
export function eventsToStateIntervals(
  events: BidsEvent[],
  recordingSeconds: number,
): PathologyAnnotation[] {
  const changes = events
    .map((e) => ({ at: e.onsetSeconds, state: stateFor(e.trialType) }))
    .filter((e): e is { at: number; state: string } => !!e.state)
    .sort((a, b) => a.at - b.at);

  const out: PathologyAnnotation[] = [];
  for (let i = 0; i < changes.length; i++) {
    const start = changes[i]!.at;
    const stop = i + 1 < changes.length ? changes[i + 1]!.at : recordingSeconds;
    if (!(stop > start)) continue;
    out.push({
      startSeconds: start,
      stopSeconds: stop,
      label: normalisePhysionetLabel(changes[i]!.state) ?? changes[i]!.state,
      channel: null,
      confidence: null,
    });
  }
  return out;
}

/* ------------------------------------------------------------- parsing --- */

export interface OpenNeuroParseResult {
  epochs: PhysionetEpoch[];
  channel: string;
  sampleRate: number;
  durationSeconds: number;
  /** Number of published state intervals applied as ground-truth labels. */
  labelledIntervals: number;
  /** A depth-monitor channel found inside the EDF, when the record carries one. */
  monitorChannel: string | null;
  /** Mean of that monitor channel over the decoded span, when present. */
  monitorMean: number | null;
}

/** Case reference is one recording: subject + session. */
export function openNeuroCaseRef(path: string): string {
  const { subject, session } = parseBidsName(path);
  return session ? `${subject}_${session}` : subject;
}

function monitorReading(bytes: Uint8Array): { channel: string; mean: number } | null {
  try {
    const header = parseEdfHeader(bytes);
    const idx = pickEdfChannel(header.channels, OPENNEURO_MONITOR_CHANNELS);
    const label = header.channels[idx] ?? "";
    if (!/^(bis|sef|sr)\b/i.test(label.trim())) return null;
    const decoded = readEdfChannel(bytes, [label], header);
    let sum = 0;
    let n = 0;
    for (const v of decoded.signal) {
      if (Number.isFinite(v)) {
        sum += v;
        n++;
      }
    }
    return n ? { channel: label.trim(), mean: Math.round((sum / n) * 100) / 100 } : null;
  } catch {
    return null;
  }
}

/**
 * Decode one ds004541 EDF (or a range-fetched prefix of one) into labelled DSA
 * epochs. Only the frontal channel is decoded — it is the derivation that is
 * comparable with this app's montage — and labels come from the published
 * events file, never from the depth model being validated.
 */
export function parseOpenNeuroRecording(
  bytes: Uint8Array,
  options: { caseRef: string; fileName: string; events?: BidsEvent[] },
): OpenNeuroParseResult {
  const decoded = readEdfChannel(bytes, OPENNEURO_PREFERRED_CHANNELS);
  const raw = deriveEpochsFromRaw(decoded.signal, decoded.sampleRate, {
    caseRef: options.caseRef,
    channel: decoded.channel,
  });
  if (!raw.length) throw new Error("no usable epochs were derived");

  const intervals = eventsToStateIntervals(options.events ?? [], decoded.durationSeconds);
  const epochs = applyAnnotations(raw, intervals, { channel: decoded.channel }).map((e) => ({
    ...e,
    externalRef: `${OPENNEURO_DS004541_SOURCE}:${options.caseRef}:${decoded.channel}:${e.atSeconds.toFixed(3)}`,
  }));

  const monitor = monitorReading(bytes);
  return {
    epochs,
    channel: decoded.channel,
    sampleRate: decoded.sampleRate,
    durationSeconds: decoded.durationSeconds,
    labelledIntervals: intervals.length,
    monitorChannel: monitor?.channel ?? null,
    monitorMean: monitor?.mean ?? null,
  };
}

/** Attach lineage, version and covariates so a batch is ready to store. */
export function openNeuroRows(
  epochs: (PhysionetEpoch & { harmonization?: HarmonizationRecord })[],
  meta: {
    datasetVersion?: string | null;
    fileName: string;
    channel: string;
    labelledIntervals: number;
    monitorChannel?: string | null;
    monitorMean?: number | null;
  },
): PhysionetImportRow[] {
  const { subject, session, task } = parseBidsName(meta.fileName);
  return epochs.map((e) => ({
    ...e,
    source: OPENNEURO_DS004541_SOURCE,
    sourceLineage: OPENNEURO_DS004541_LINEAGE,
    datasetVersion: meta.datasetVersion ?? null,
    covariates: {
      subject,
      session,
      task: task ?? "anesthesia",
      channel: meta.channel,
      setting: "general_anaesthesia",
      labelled_intervals: meta.labelledIntervals,
      monitor_channel: meta.monitorChannel ?? null,
      monitor_mean: meta.monitorMean ?? null,
    },
    ...(e.harmonization ? { harmonization: e.harmonization } : {}),
  }));
}
