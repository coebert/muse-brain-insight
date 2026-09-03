/**
 * PhysioNet ingest — burst-suppression labels and DSA power features from two
 * open anaesthesia collections.
 *
 *   1. `eeg-gaba-anesthesia`  — raw frontal EEG recorded during GABAergic
 *      anaesthesia. Exported per case as a CSV of samples (time column plus one
 *      column per channel). The app derives its own DSA power features and
 *      burst-suppression labels from those samples with the same detector the
 *      bedside pipeline uses, so a derived label is reproducible.
 *
 *   2. `eeg-power-anesthesia` — pre-computed spectral power during anaesthesia.
 *      Exported as a CSV whose header carries the frequency axis (one column
 *      per frequency bin), optionally with a state/label column. Nothing is
 *      recomputed from raw signal here; the published power is resampled onto
 *      the app's 0.5–30 Hz DSA grid and any published label is kept verbatim.
 *
 * Both datasets use montages, references and bandwidths that are not this
 * app's headband, so every stored row keeps its own `source_lineage`. Rows are
 * population-level training material for COEBIS and the diagnostic models —
 * they never enter device-specific paired alignment.
 */

import { bandPower, computePsd, peakToPeak, spectralEdge, type Psd } from "./dsp";
import type { HarmonizationRecord, SourceMontage } from "./harmonization";

export const PHYSIONET_GABA_SOURCE = "physionet-eeg-gaba-anesthesia";
export const PHYSIONET_GABA_LINEAGE = "external:physionet:eeg-gaba-anesthesia";
export const PHYSIONET_POWER_SOURCE = "physionet-eeg-power-anesthesia";
export const PHYSIONET_POWER_LINEAGE = "external:physionet:eeg-power-anesthesia";

/** DSA grid every stored spectrum is expressed on. */
export const DSA_FREQ_START_HZ = 0.5;
export const DSA_FREQ_STEP_HZ = 0.5;
export const DSA_FREQ_END_HZ = 30;
const DSA_BINS = Math.round((DSA_FREQ_END_HZ - DSA_FREQ_START_HZ) / DSA_FREQ_STEP_HZ) + 1;

export type PhysionetDataset = "gaba" | "power";

export interface PhysionetBands {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

/** One stored epoch: DSA power features plus a burst-suppression verdict. */
export interface PhysionetEpoch {
  caseRef: string;
  channel: string | null;
  atSeconds: number;
  epochSeconds: number;
  sampleRate: number | null;
  /** dB values on the 0.5–30 Hz DSA grid. */
  spectrumDb: number[];
  bands: PhysionetBands;
  totalPower: number;
  sef95: number;
  /** Trailing-window suppression ratio, %. */
  suppressionRatio: number;
  isSuppressed: boolean;
  /** `burst_suppression`, `suppression`, `anaesthetised`, `awake`, … */
  label: string | null;
  /** `dataset` when the collection published it, `derived` when we computed it. */
  labelSource: "dataset" | "derived";
  externalRef: string;
}

export interface PhysionetImportRow extends PhysionetEpoch {
  source: string;
  sourceLineage: string;
  datasetVersion: string | null;
  covariates: Record<string, string | number | null>;
  /** Montage/reference transform applied before pooling, for auditing. */
  harmonization?: HarmonizationRecord;
}


/* ------------------------------------------------------------------ CSV --- */

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === "\t" || ch === ";") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.startsWith("#"));
  if (!lines.length) return { header: [], rows: [] };
  return {
    header: splitCsvLine(lines[0]!).map((h) => h.toLowerCase()),
    rows: lines.slice(1).map(splitCsvLine),
  };
}

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ----------------------------------------------------------- raw signal --- */

export interface PhysionetRawRecording {
  channels: string[];
  /** Hz, taken from the time column when present. */
  sampleRate: number;
  /** One µV series per channel, in `channels` order. */
  signals: Float64Array[];
}

const TIME_KEYS = new Set(["time", "t", "seconds", "sec", "timestamp", "time_s"]);
const IGNORED_KEYS = new Set(["index", "sample", "n", ""]);

/**
 * Parse a raw-EEG CSV export from `eeg-gaba-anesthesia`.
 *
 * The sampling rate comes from the time column when there is one; otherwise
 * supply `fallbackSampleRate` (the collection records at 250 Hz).
 */
export function parsePhysionetRawCsv(
  text: string,
  fallbackSampleRate = 250,
): PhysionetRawRecording {
  const { header, rows } = parseCsv(text);
  if (!header.length || !rows.length) throw new Error("The raw EEG file is empty.");

  const timeIdx = header.findIndex((h) => TIME_KEYS.has(h));
  const channelIdx: number[] = [];
  const channels: string[] = [];
  header.forEach((h, i) => {
    if (i === timeIdx || IGNORED_KEYS.has(h)) return;
    channelIdx.push(i);
    channels.push(h.toUpperCase());
  });
  if (!channels.length) throw new Error("No EEG channel columns were found.");

  const signals = channels.map(() => new Float64Array(rows.length));
  const times: number[] = [];
  let kept = 0;
  for (const row of rows) {
    const values = channelIdx.map((i) => num(row[i]));
    if (values.every((v) => v == null)) continue;
    channelIdx.forEach((_, c) => {
      signals[c]![kept] = values[c] ?? 0;
    });
    if (timeIdx >= 0) {
      const t = num(row[timeIdx]);
      if (t != null) times.push(t);
    }
    kept++;
  }
  if (!kept) throw new Error("No numeric EEG samples were found.");

  let sampleRate = fallbackSampleRate;
  if (times.length > 2) {
    const span = times[times.length - 1]! - times[0]!;
    // Files that timestamp in milliseconds are common; detect and rescale.
    const scale = span > times.length * 10 ? 1000 : 1;
    const seconds = span / scale;
    if (seconds > 0) sampleRate = (times.length - 1) / seconds;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = fallbackSampleRate;

  return {
    channels,
    sampleRate: Math.round(sampleRate * 100) / 100,
    signals: signals.map((s) => s.subarray(0, kept) as Float64Array),
  };
}

/** Resample an arbitrary PSD onto the app's 0.5–30 Hz DSA grid, in dB. */
function psdToDsaDb(freqs: ArrayLike<number>, power: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let b = 0; b < DSA_BINS; b++) {
    const f = DSA_FREQ_START_HZ + b * DSA_FREQ_STEP_HZ;
    // Nearest published bin; the grids differ between datasets.
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < freqs.length; k++) {
      const d = Math.abs(freqs[k]! - f);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    out.push(10 * Math.log10(Math.max(power[best] ?? 0, 1e-6)));
  }
  return out;
}

function bandsOf(psd: Psd): PhysionetBands {
  return {
    delta: bandPower(psd, 0.5, 4),
    theta: bandPower(psd, 4, 8),
    alpha: bandPower(psd, 8, 13),
    beta: bandPower(psd, 13, 30),
    gamma: bandPower(psd, 30, 45),
  };
}

export interface RawEpochOptions {
  caseRef: string;
  channel?: string | null;
  epochSeconds?: number;
  hopSeconds?: number;
  /** Peak-to-peak µV below which a 0.5 s segment counts as suppressed. */
  suppressionThresholdUv?: number;
  /** Trailing window, seconds, for the suppression ratio. */
  srWindowSeconds?: number;
}

/**
 * Derive DSA power features and burst-suppression labels from a raw channel,
 * using the same 0.5 s peak-to-peak rule and trailing SR window as the bedside
 * detector so an imported label matches what the app would have reported.
 */
export function deriveEpochsFromRaw(
  signal: Float64Array,
  sampleRate: number,
  options: RawEpochOptions,
): PhysionetEpoch[] {
  const epochSeconds = options.epochSeconds ?? 4;
  const hopSeconds = options.hopSeconds ?? 4;
  const threshold = options.suppressionThresholdUv ?? 8;
  const srWindow = options.srWindowSeconds ?? 60;
  const channel = options.channel ?? null;

  const win = Math.round(epochSeconds * sampleRate);
  const hop = Math.round(hopSeconds * sampleRate);
  const seg = Math.max(1, Math.round(0.5 * sampleRate));
  if (win < 8 || hop < 1) return [];

  const epochs: PhysionetEpoch[] = [];
  const history: { t: number; fraction: number }[] = [];

  for (let start = 0; start + win <= signal.length; start += hop) {
    const window = signal.subarray(start, start + win) as Float64Array;
    const t = start / sampleRate;

    let suppressed = 0;
    let segments = 0;
    for (let i = 0; i + seg <= window.length; i += seg) {
      if (peakToPeak(window, i, i + seg) < threshold) suppressed++;
      segments++;
    }
    const fraction = segments ? suppressed / segments : 0;

    history.push({ t, fraction });
    while (history.length && t - history[0]!.t > srWindow) history.shift();
    const ratio =
      (history.reduce((acc, h) => acc + h.fraction, 0) / Math.max(history.length, 1)) * 100;

    const psd = computePsd(window, sampleRate);
    const bands = bandsOf(psd);
    const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma;
    const isSuppressed = fraction >= 0.5;

    epochs.push({
      caseRef: options.caseRef,
      channel,
      atSeconds: Math.round(t * 1000) / 1000,
      epochSeconds,
      sampleRate,
      spectrumDb: psdToDsaDb(psd.freqs, psd.power),
      bands,
      totalPower,
      sef95: spectralEdge(psd, 0.95),
      suppressionRatio: Math.round(ratio * 100) / 100,
      isSuppressed,
      label: isSuppressed ? "burst_suppression" : ratio >= 5 ? "suppression_burden" : null,
      labelSource: "derived",
      externalRef: `${PHYSIONET_GABA_SOURCE}:${options.caseRef}:${channel ?? "eeg"}:${t.toFixed(3)}`,
    });
  }

  return epochs;
}

/* -------------------------------------------------------- power spectra --- */

const LABEL_KEYS = new Set(["label", "state", "stage", "annotation", "class", "condition"]);
const CHANNEL_KEYS = new Set(["channel", "chan", "electrode"]);

/** Normalise the many spellings of a published anaesthesia state label. */
export function normalisePhysionetLabel(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!v) return null;
  if (/(burst.*suppress|^bs$|suppression)/.test(v)) return "burst_suppression";
  if (/(isoelectric|flat)/.test(v)) return "isoelectric";
  if (/(awake|conscious|baseline|eyes_(open|closed))/.test(v) && !/un/.test(v)) return "awake";
  if (/(sedat|light)/.test(v)) return "sedated";
  if (/(unconscious|deep|anesth|anaesth|loc|maintenance)/.test(v)) return "anaesthetised";
  if (/(emergence|recovery|roc)/.test(v)) return "emergence";
  return v;
}

export interface PowerCsvOptions {
  caseRef: string;
  epochSeconds?: number;
  /** Used when the file carries no time column. */
  strideSeconds?: number;
  /** Published power is dB when true, linear µV²/Hz when false. */
  valuesAreDb?: boolean;
}

/**
 * Parse a pre-computed spectral CSV from `eeg-power-anesthesia`.
 *
 * The header carries the frequency axis: numeric columns (e.g. `0.5`, `1`, …)
 * or labelled ones (e.g. `pow_8.0hz`). Optional `time`, `channel` and
 * `label`/`state` columns are honoured when present.
 */
export function parsePhysionetPowerCsv(
  text: string,
  options: PowerCsvOptions,
): PhysionetEpoch[] {
  const { header, rows } = parseCsv(text);
  if (!header.length || !rows.length) throw new Error("The power file is empty.");

  const timeIdx = header.findIndex((h) => TIME_KEYS.has(h) || h === "epoch");
  const labelIdx = header.findIndex((h) => LABEL_KEYS.has(h));
  const channelIdx = header.findIndex((h) => CHANNEL_KEYS.has(h));

  const freqCols: { idx: number; hz: number }[] = [];
  header.forEach((h, i) => {
    if (i === timeIdx || i === labelIdx || i === channelIdx) return;
    const m = h.match(/(-?\d+(?:\.\d+)?)\s*(hz)?$/);
    if (!m) return;
    const hz = Number(m[1]);
    if (Number.isFinite(hz) && hz >= 0 && hz <= 200) freqCols.push({ idx: i, hz });
  });
  if (freqCols.length < 4) {
    throw new Error("No frequency columns were found in the power file header.");
  }
  freqCols.sort((a, b) => a.hz - b.hz);

  const epochSeconds = options.epochSeconds ?? 4;
  const stride = options.strideSeconds ?? epochSeconds;
  const valuesAreDb = options.valuesAreDb ?? false;
  const freqs = freqCols.map((c) => c.hz);
  const binWidth =
    freqs.length > 1 ? Math.max((freqs[freqs.length - 1]! - freqs[0]!) / (freqs.length - 1), 1e-6) : 1;

  const out: PhysionetEpoch[] = [];
  rows.forEach((row, r) => {
    const power = new Float64Array(freqs.length);
    let any = false;
    freqCols.forEach((c, k) => {
      const v = num(row[c.idx]);
      if (v == null) return;
      any = true;
      power[k] = valuesAreDb ? Math.pow(10, v / 10) : Math.max(v, 0);
    });
    if (!any) return;

    const t = (timeIdx >= 0 ? num(row[timeIdx]) : null) ?? r * stride;
    const channel = channelIdx >= 0 ? (row[channelIdx] || null) : null;
    const rawLabel = labelIdx >= 0 ? (row[labelIdx] ?? "") : "";
    const label = rawLabel ? normalisePhysionetLabel(rawLabel) : null;

    const psd: Psd = { freqs: Float64Array.from(freqs), power, binWidth };
    const bands = bandsOf(psd);
    const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma;
    const isSuppressed = label === "burst_suppression" || label === "isoelectric";

    out.push({
      caseRef: options.caseRef,
      channel: channel ? channel.toUpperCase() : null,
      atSeconds: Math.round(t * 1000) / 1000,
      epochSeconds,
      // Published spectra carry no raw sampling rate.
      sampleRate: null,
      spectrumDb: psdToDsaDb(freqs, power),
      bands,
      totalPower,
      sef95: spectralEdge(psd, 0.95),
      // Only the published label speaks to suppression here; nothing is
      // inferred from power alone, which would invent a detector verdict.
      suppressionRatio: isSuppressed ? 100 : 0,
      isSuppressed,
      label,
      labelSource: label ? "dataset" : "derived",
      externalRef: `${PHYSIONET_POWER_SOURCE}:${options.caseRef}:${
        channel ?? "eeg"
      }:${t.toFixed(3)}`,
    });
  });

  if (!out.length) throw new Error("No usable spectral rows were found.");
  return out;
}

/* ------------------------------------------------------------- lineage --- */

export function lineageFor(dataset: PhysionetDataset): { source: string; lineage: string } {
  return dataset === "gaba"
    ? { source: PHYSIONET_GABA_SOURCE, lineage: PHYSIONET_GABA_LINEAGE }
    : { source: PHYSIONET_POWER_SOURCE, lineage: PHYSIONET_POWER_LINEAGE };
}

/**
 * Montage each collection publishes, used when the export carries no channel
 * label to infer from. Both PhysioNet anaesthesia collections are clinical
 * recordings referenced away from the forehead, unlike this app's short
 * bipolar frontal derivation.
 */
export const DATASET_MONTAGE: Record<PhysionetDataset, SourceMontage> = {
  gaba: {
    channel: "FP1-A1",
    reference: "mastoid",
    lowHz: 0.1,
    highHz: 50,
    sampleRateHz: 250,
    note: "Frontal clinical montage referenced to mastoid.",
  },
  power: {
    channel: null,
    reference: "linked-ears",
    lowHz: 0.5,
    highHz: 40,
    sampleRateHz: null,
    note: "Pre-computed multitaper power from a linked-ears clinical montage.",
  },
};

/** Attach lineage, harmonisation and covariates so a batch is ready to store. */
export function toImportRows(
  dataset: PhysionetDataset,
  epochs: (PhysionetEpoch & { harmonization?: HarmonizationRecord })[],
  meta: {
    datasetVersion?: string | null;
    covariates?: Record<string, string | number | null>;
    harmonization?: HarmonizationRecord;
  } = {},
): PhysionetImportRow[] {
  const { source, lineage } = lineageFor(dataset);
  return epochs.map((e) => ({
    ...e,
    source,
    sourceLineage: lineage,
    datasetVersion: meta.datasetVersion ?? null,
    covariates: meta.covariates ?? {},
    ...(e.harmonization ?? meta.harmonization
      ? { harmonization: e.harmonization ?? meta.harmonization! }
      : {}),
  }));
}

export interface PhysionetSummary {
  cases: number;
  epochs: number;
  suppressedEpochs: number;
  meanSuppressionRatio: number;
  meanSef95: number;
  labels: { label: string; count: number }[];
}

export function summarisePhysionet(epochs: PhysionetEpoch[]): PhysionetSummary {
  const labels = new Map<string, number>();
  let sr = 0;
  let sef = 0;
  let suppressed = 0;
  for (const e of epochs) {
    sr += e.suppressionRatio;
    sef += e.sef95;
    if (e.isSuppressed) suppressed++;
    if (e.label) labels.set(e.label, (labels.get(e.label) ?? 0) + 1);
  }
  const n = Math.max(epochs.length, 1);
  return {
    cases: new Set(epochs.map((e) => e.caseRef)).size,
    epochs: epochs.length,
    suppressedEpochs: suppressed,
    meanSuppressionRatio: Math.round((sr / n) * 100) / 100,
    meanSef95: Math.round((sef / n) * 100) / 100,
    labels: [...labels.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}
