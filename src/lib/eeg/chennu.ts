/**
 * Cambridge propofol sedation ingest (Chennu et al.).
 *
 * Healthy volunteers were taken through four target-controlled propofol
 * levels — baseline, mild, moderate and recovery — while a behavioural task
 * recorded whether they still answered. That makes it one of the very few open
 * anaesthesia collections whose label is a person responding or not, rather
 * than another monitor's number, so it grades the index against the thing
 * depth is meant to mean.
 *
 * Two honest labels come out of it:
 *   • the drug level (baseline / mild / moderate / recovery), and
 *   • the behavioural verdict at that level (responsive / unresponsive).
 *
 * A sedated volunteer who still answers is stored as responsive, not as awake:
 * their drug state and their behaviour differ, and flattening the two would
 * blur exactly the boundary the state fit exists to sharpen. A level with no
 * behavioural verdict is stored as plain `sedated`, which the state fit drops.
 *
 * Recordings are 91-channel high-density EGI, nothing like this app's frontal
 * headband, so every row keeps its own lineage and never enters device
 * alignment.
 */

import type { SourceMontage } from "./harmonization";
import {
  deriveEpochsFromRaw,
  parsePhysionetPowerCsv,
  parsePhysionetRawCsv,
  type PhysionetEpoch,
  type PhysionetImportRow,
} from "./physionet";

export const CHENNU_SOURCE = "chennu-propofol-sedation";
export const CHENNU_LINEAGE = "external:cambridge:chennu-propofol-sedation";

/** Sampling rate the published recordings are distributed at. */
export const CHENNU_SAMPLE_RATE = 250;

/** Target-controlled level each block was recorded at. */
export type ChennuLevel = "baseline" | "mild" | "moderate" | "recovery";

export const CHENNU_LEVELS: { key: ChennuLevel; label: string; targetUgMl: number | null }[] = [
  { key: "baseline", label: "Baseline (no drug)", targetUgMl: 0 },
  { key: "mild", label: "Mild sedation", targetUgMl: 0.6 },
  { key: "moderate", label: "Moderate sedation", targetUgMl: 1.2 },
  { key: "recovery", label: "Recovery", targetUgMl: null },
];

/** Behavioural verdict for the block, when the study recorded one. */
export type ChennuResponse = "responsive" | "unresponsive" | "unknown";

export const CHENNU_MONTAGE: SourceMontage = {
  channel: null,
  reference: "average",
  lowHz: 0.5,
  highHz: 45,
  sampleRateHz: CHENNU_SAMPLE_RATE,
  note: "91-channel EGI HydroCel, average reference, high-density scalp montage.",
};

/**
 * Stored label for a block.
 *
 * The behavioural verdict wins where there is one, because that is the
 * measured fact; the drug level alone only says what was given.
 */
export function chennuLabel(level: ChennuLevel, response: ChennuResponse): string {
  if (level === "baseline") return "awake";
  if (level === "recovery") return response === "unresponsive" ? "sedated_unresponsive" : "emergence";
  if (response === "responsive") return "sedated_responsive";
  if (response === "unresponsive") return "sedated_unresponsive";
  return "sedated";
}

export interface ChennuBlockMeta {
  /** Volunteer identifier, anonymised in the published collection. */
  caseRef: string;
  level: ChennuLevel;
  response: ChennuResponse;
  /** Measured plasma propofol, µg/ml, when the export carries it. */
  plasmaUgMl?: number | null;
}

export type ChennuFormat = "raw" | "power";

/** Volunteer id from an export filename, e.g. "S07_moderate.csv" → "S07". */
export function chennuCaseRef(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const m = stem.match(/^([A-Za-z]*\d+)/);
  return (m?.[1] ?? stem).toUpperCase();
}

/** Level read off an export filename, when it names one. */
export function chennuLevelFromName(fileName: string): ChennuLevel | null {
  const v = fileName.toLowerCase();
  if (/baseline|rest|awake/.test(v)) return "baseline";
  if (/recovery|recover/.test(v)) return "recovery";
  if (/moderate|mod\b|deep/.test(v)) return "moderate";
  if (/mild/.test(v)) return "mild";
  return null;
}

/**
 * Parse one exported block into stored epochs.
 *
 * `raw` files are sample CSVs and get DSA features derived with the bedside
 * detector; `power` files are published spectra mapped onto the DSA grid. The
 * block's label is stamped on every epoch either way — the study's labels are
 * per block, not per second.
 */
export function parseChennuBlock(
  text: string,
  format: ChennuFormat,
  meta: ChennuBlockMeta,
): PhysionetEpoch[] {
  const label = chennuLabel(meta.level, meta.response);
  const epochs: PhysionetEpoch[] = [];

  if (format === "raw") {
    const rec = parsePhysionetRawCsv(text, CHENNU_SAMPLE_RATE);
    rec.signals.forEach((signal, i) => {
      const channel = rec.channels[i] ?? null;
      epochs.push(
        ...deriveEpochsFromRaw(signal, rec.sampleRate, { caseRef: meta.caseRef, channel }),
      );
    });
  } else {
    epochs.push(...parsePhysionetPowerCsv(text, { caseRef: meta.caseRef }));
  }

  if (!epochs.length) throw new Error("No usable epochs in that block.");

  return epochs.map((e) => ({
    ...e,
    // A derived burst-suppression verdict stays as computed; the block label
    // describes the person, so it only replaces a label the parser guessed.
    label: e.label === "burst_suppression" || e.label === "isoelectric" ? e.label : label,
    labelSource: "dataset" as const,
    externalRef: `${CHENNU_SOURCE}:${meta.caseRef}:${meta.level}:${e.channel ?? "eeg"}:${e.atSeconds.toFixed(3)}`,
  }));
}

/** Attach the Chennu lineage and the block's covariates, ready to store. */
export function toChennuRows(
  epochs: PhysionetEpoch[],
  meta: ChennuBlockMeta,
): PhysionetImportRow[] {
  const target = CHENNU_LEVELS.find((l) => l.key === meta.level)?.targetUgMl ?? null;
  return epochs.map((e) => ({
    ...e,
    source: CHENNU_SOURCE,
    sourceLineage: CHENNU_LINEAGE,
    datasetVersion: "chennu-2016",
    covariates: {
      level: meta.level,
      responsiveness: meta.response,
      target_propofol_ug_ml: target,
      plasma_propofol_ug_ml: meta.plasmaUgMl ?? null,
      drug: "propofol",
    },
  }));
}
