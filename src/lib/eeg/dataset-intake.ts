/**
 * Automated public-dataset intake.
 *
 * The manual import panels each take a file a clinician downloaded by hand.
 * This module describes the *configured* public sources instead, so a scan can
 * discover eligible files, fetch them, push them through the existing parser →
 * harmonisation → storage path, and write down exactly where every epoch came
 * from and under what licence.
 *
 * Three rules are non-negotiable and are enforced here rather than in the UI:
 *
 *   1. **Licence gating.** A source is only eligible when its licence permits
 *      programmatic retrieval without a signed DUA. Credentialed PhysioNet
 *      collections stay listed, but ineligible, with the reason shown.
 *   2. **Lineage separation.** Every source keeps its own `source_lineage`, so
 *      nothing it contributes can be pooled into the device-specific COEBIS
 *      fit; it can only feed tier-level priors and per-lineage benchmarking.
 *   3. **Provenance.** Each fetched file records its URL, byte size, content
 *      digest, licence, dataset version and harmonisation record, so a model
 *      fitted on it can be audited back to the published artefact.
 */

import type { SourceMontage } from "./harmonization";
import { DATASET_MONTAGE } from "./physionet";
import { SEDATION_ICU_MONTAGE } from "./sedation-icu";

export const INTAKE_VERSION = "intake-1.0.0";

/** How a source's files are parsed once downloaded. */
export type IntakeKind =
  | "physionet-raw"
  | "physionet-power"
  | "dose1"
  | "dose1-peeg"
  | "icare";

/** Whether the licence allows this scan to fetch files at all. */
export type IntakeAccess = "open" | "credentialed" | "manual";

export type IntakeListing =
  /** PhysioNet publishes a plain-text RECORDS index of every file. */
  | { type: "records-file"; url: string }
  /** Zenodo exposes a JSON record whose `files[]` carry direct links. */
  | { type: "zenodo"; recordUrl: string }
  /** A fixed list of file URLs, for sources with no machine-readable index. */
  | { type: "manifest"; files: { name: string; url: string }[] };

export interface IntakeSource {
  id: string;
  label: string;
  kind: IntakeKind;
  /** Stored on every epoch; keeps this collection its own model lineage. */
  lineage: string;
  datasetVersion: string | null;
  licence: string;
  licenceUrl: string;
  access: IntakeAccess;
  /** Why an access mode other than `open` blocks automated retrieval. */
  accessNote?: string;
  homepage: string;
  listing: IntakeListing;
  /** Files whose names fail this test are ignored (checksums, docs, WFDB headers). */
  filePattern: RegExp;
  /** Native sampling rate used when a file carries no usable time column. */
  fallbackSampleRate: number;
  montage: SourceMontage;
  /**
   * Some records publish their per-recording files inside one zip. When set,
   * an archive whose name matches is downloaded once and expanded in memory;
   * each member matching `filePattern` is then planned as its own file, so
   * provenance and de-duplication stay per recording.
   */
  archivePattern?: RegExp;
  /** Cap on the archive download itself, separate from the per-member cap. */
  maxArchiveBytes?: number;
  /** Safety rails so one scan cannot pull an entire archive. */
  maxFilesPerRun: number;
  maxBytesPerFile: number;
}

export const INTAKE_SOURCES: IntakeSource[] = [
  {
    id: "physionet-eeg-gaba-anesthesia",
    label: "PhysioNet — GABA anaesthesia (raw frontal EEG)",
    kind: "physionet-raw",
    lineage: "external:physionet:eeg-gaba-anesthesia",
    datasetVersion: "1.0.0",
    licence: "PhysioNet Contributor Review Health Data Licence 1.5.0",
    licenceUrl: "https://physionet.org/content/eeg-gaba-anesthesia/view-license/1.0.0/",
    access: "credentialed",
    accessNote:
      "Credentialed access with a signed data use agreement; files cannot be fetched by an unattended scan.",
    homepage: "https://physionet.org/content/eeg-gaba-anesthesia/1.0.0/",
    listing: {
      type: "records-file",
      url: "https://physionet.org/files/eeg-gaba-anesthesia/1.0.0/RECORDS",
    },
    filePattern: /\.csv$/i,
    fallbackSampleRate: 250,
    montage: DATASET_MONTAGE.gaba,
    maxFilesPerRun: 8,
    maxBytesPerFile: 60_000_000,
  },
  {
    id: "physionet-eeg-power-anesthesia",
    label: "PhysioNet — anaesthesia power spectra",
    kind: "physionet-power",
    lineage: "external:physionet:eeg-power-anesthesia",
    datasetVersion: "1.0.0",
    licence: "PhysioNet Restricted Health Data Licence 1.5.0",
    licenceUrl: "https://physionet.org/content/eeg-power-anesthesia/view-license/1.0.0/",
    access: "credentialed",
    accessNote:
      "Restricted access: credentialed user plus a signed DUA, so automated download is not permitted.",
    homepage: "https://physionet.org/content/eeg-power-anesthesia/1.0.0/",
    listing: {
      type: "records-file",
      url: "https://physionet.org/files/eeg-power-anesthesia/1.0.0/RECORDS",
    },
    filePattern: /\.csv$/i,
    fallbackSampleRate: 250,
    montage: DATASET_MONTAGE.power,
    maxFilesPerRun: 12,
    maxBytesPerFile: 40_000_000,
  },
  {
    id: "zenodo-dose-i",
    label: "DOSE-I — procedural sedation EEG (Zenodo)",
    // The record's `pEEG.zip` carries the published 1 Hz spectral features and
    // MOAA/S depth scores; the 700 MB raw archive stays out of automated reach.
    kind: "dose1-peeg",
    lineage: "external:zenodo:dose-i",
    datasetVersion: "2025-11 (v1)",
    licence: "Creative Commons Attribution 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    access: "open",
    accessNote:
      "Open CC-BY record with a click-through data use agreement: no re-identification, research use only.",
    homepage: "https://zenodo.org/records/18483292",
    listing: { type: "zenodo", recordUrl: "https://zenodo.org/api/records/18483292" },
    filePattern: /_pEEG\.csv$/i,
    archivePattern: /^pEEG\.zip$/i,
    maxArchiveBytes: 60_000_000,
    fallbackSampleRate: 125,
    montage: SEDATION_ICU_MONTAGE.dose1,
    maxFilesPerRun: 10,
    maxBytesPerFile: 40_000_000,
  },
  {
    id: "physionet-i-care",
    label: "PhysioNet — I-CARE post-arrest ICU EEG",
    kind: "icare",
    lineage: "external:physionet:i-care",
    datasetVersion: "2.1",
    licence: "PhysioNet Restricted Health Data Licence 1.5.0",
    licenceUrl: "https://physionet.org/content/i-care/view-license/2.1/",
    access: "credentialed",
    accessNote:
      "Credentialed access with a signed DUA; the scan lists the records but will not download them.",
    homepage: "https://physionet.org/content/i-care/2.1/",
    listing: { type: "records-file", url: "https://physionet.org/files/i-care/2.1/RECORDS" },
    filePattern: /\.csv$/i,
    fallbackSampleRate: 100,
    montage: SEDATION_ICU_MONTAGE.icare,
    maxFilesPerRun: 6,
    maxBytesPerFile: 80_000_000,
  },
];

export function findSource(id: string): IntakeSource | undefined {
  return INTAKE_SOURCES.find((s) => s.id === id);
}

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Licence gate. Only `open` sources may be retrieved automatically; everything
 * else is surfaced with the reason so a clinician can obtain it by hand and use
 * the manual import panels instead.
 */
export function checkEligibility(source: IntakeSource): Eligibility {
  if (source.access === "open") {
    return { eligible: true, reason: `${source.licence} permits programmatic retrieval.` };
  }
  return {
    eligible: false,
    reason:
      source.accessNote ??
      `${source.licence} does not permit unattended download; import the files manually.`,
  };
}

/* ----------------------------------------------------------- planning --- */

export interface DiscoveredFile {
  name: string;
  url: string;
  /** Byte size when the index publishes one. */
  bytes: number | null;
}

export interface PlannedFile extends DiscoveredFile {
  caseRef: string;
}

export interface IntakePlan {
  sourceId: string;
  eligible: boolean;
  reason: string;
  discovered: number;
  skippedAlreadyIngested: number;
  skippedTooLarge: number;
  skippedPattern: number;
  files: PlannedFile[];
}

/** Case reference from a published path, e.g. "case07/eeg.csv" → "case07-eeg". */
export function caseRefFromPath(path: string): string {
  return path
    .replace(/\.[^./]+$/, "")
    .replace(/^\.?\//, "")
    .replace(/[/\\]+/g, "-")
    .slice(0, 120);
}

/**
 * Decide what this run should fetch: eligible source, matching filenames, not
 * already ingested, within the per-file size cap, capped at `maxFilesPerRun`.
 */
export function planIntake(
  source: IntakeSource,
  discovered: DiscoveredFile[],
  alreadyIngested: Set<string>,
  limit = source.maxFilesPerRun,
): IntakePlan {
  const gate = checkEligibility(source);
  const plan: IntakePlan = {
    sourceId: source.id,
    eligible: gate.eligible,
    reason: gate.reason,
    discovered: discovered.length,
    skippedAlreadyIngested: 0,
    skippedTooLarge: 0,
    skippedPattern: 0,
    files: [],
  };
  if (!gate.eligible) return plan;

  for (const f of discovered) {
    if (!source.filePattern.test(f.name)) {
      plan.skippedPattern++;
      continue;
    }
    if (alreadyIngested.has(f.url) || alreadyIngested.has(f.name)) {
      plan.skippedAlreadyIngested++;
      continue;
    }
    if (f.bytes != null && f.bytes > source.maxBytesPerFile) {
      plan.skippedTooLarge++;
      continue;
    }
    if (plan.files.length >= Math.max(0, limit)) continue;
    plan.files.push({ ...f, caseRef: caseRefFromPath(f.name) });
  }
  return plan;
}

/* --------------------------------------------------------- provenance --- */

export interface ProvenanceRecord {
  intakeVersion: string;
  sourceId: string;
  lineage: string;
  datasetVersion: string | null;
  licence: string;
  licenceUrl: string;
  access: IntakeAccess;
  homepage: string;
  fileName: string;
  fileUrl: string;
  bytes: number;
  /** SHA-256 of the downloaded bytes, so a re-fetch can be compared. */
  digest: string;
  fetchedAt: string;
  harmonizationVersion: string | null;
  harmonizationSummary: string | null;
}

export function buildProvenance(
  source: IntakeSource,
  file: { name: string; url: string; bytes: number; digest: string },
  harmonization: { version: string; summary: string } | null,
  fetchedAt = new Date().toISOString(),
): ProvenanceRecord {
  return {
    intakeVersion: INTAKE_VERSION,
    sourceId: source.id,
    lineage: source.lineage,
    datasetVersion: source.datasetVersion,
    licence: source.licence,
    licenceUrl: source.licenceUrl,
    access: source.access,
    homepage: source.homepage,
    fileName: file.name,
    fileUrl: file.url,
    bytes: file.bytes,
    digest: file.digest,
    fetchedAt,
    harmonizationVersion: harmonization?.version ?? null,
    harmonizationSummary: harmonization?.summary ?? null,
  };
}

/* ------------------------------------------------------- index parsing --- */

/** PhysioNet RECORDS: one relative path per line. */
export function parseRecordsIndex(text: string, baseUrl: string): DiscoveredFile[] {
  const base = baseUrl.replace(/RECORDS$/i, "");
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((name) => ({ name, url: base + name, bytes: null }));
}

/** Zenodo record JSON: `files[]` with `key`, `size` and a download link. */
export function parseZenodoIndex(json: unknown): DiscoveredFile[] {
  const files = (json as { files?: unknown })?.files;
  if (!Array.isArray(files)) return [];
  const out: DiscoveredFile[] = [];
  for (const raw of files) {
    const f = raw as {
      key?: string;
      filename?: string;
      size?: number;
      filesize?: number;
      links?: { self?: string; download?: string };
    };
    const name = f.key ?? f.filename;
    const url = f.links?.download ?? f.links?.self;
    if (!name || !url) continue;
    out.push({ name, url, bytes: f.size ?? f.filesize ?? null });
  }
  return out;
}

/* ------------------------------------------------------------ results --- */

export interface IntakeFileResult {
  file: string;
  url: string;
  status: "ingested" | "skipped" | "failed";
  epochs: number;
  inserted: number;
  detail: string;
  provenance: ProvenanceRecord | null;
}

export interface IntakeSourceResult {
  sourceId: string;
  label: string;
  lineage: string;
  licence: string;
  access: IntakeAccess;
  eligible: boolean;
  reason: string;
  discovered: number;
  attempted: number;
  ingested: number;
  epochsInserted: number;
  files: IntakeFileResult[];
}

export interface IntakeRunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  sources: IntakeSourceResult[];
}
