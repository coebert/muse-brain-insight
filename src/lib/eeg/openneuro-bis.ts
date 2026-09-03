/**
 * OpenNeuro BIS import — depth-monitor numerics published alongside BIDS EEG.
 *
 * Some anaesthesia BIDS records ship the bedside depth monitor as a continuous
 * recording (`*_recording-bis_physio.tsv.gz` with a JSON sidecar naming the
 * columns, sampling frequency and start time) or as a plain per-case table with
 * a time column and a BIS column. Either way the values are *commercial monitor
 * readings*, not anything this app computed, so — exactly as with VitalDB —
 * they are stored as external reference readings and never as paired readings:
 * there is no app-side index in the file to align against, and pairing them
 * would fit the alignment against itself.
 *
 * Each dataset keeps its own lineage (`external:openneuro:<datasetId>`), so a
 * record's readings inform the population prior and per-lineage benchmarking
 * without ever being pooled with another dataset or with the device-specific
 * COEBIS fit.
 */

import { ageBandOf, frailtyFromAsa, sexOf, type VitalDbCovariates } from "./vitaldb";

export const OPENNEURO_BIS_SOURCE = "openneuro";

/** Lineage key for a given OpenNeuro accession, e.g. "ds004541". */
export function openNeuroBisLineage(datasetId: string): string {
  return `external:openneuro:${normaliseDatasetId(datasetId)}`;
}

export function normaliseDatasetId(raw: string): string {
  const m = raw.trim().toLowerCase().match(/ds\d{6}/);
  return m ? m[0] : raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

/* ---------------------------------------------------------- participants -- */

export interface OpenNeuroParticipant {
  subject: string;
  age: number | null;
  sex: string | null;
  asa: string | null;
  /** Anaesthetic/sedative agents as the record names them, when published. */
  agents: string[];
}

function splitDelimited(line: string): string[] {
  return (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) =>
    c.trim().replace(/^"|"$/g, ""),
  );
}

function numOrNull(raw: string | undefined): number | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (!v || v.toLowerCase() === "n/a") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function textOrNull(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return !v || v.toLowerCase() === "n/a" ? null : v;
}

/** Parse a BIDS `participants.tsv`, keyed by participant id ("sub-02"). */
export function parseParticipantsTsv(text: string): Map<string, OpenNeuroParticipant> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const out = new Map<string, OpenNeuroParticipant>();
  if (!lines.length) return out;
  const header = splitDelimited(lines[0]!).map((h) => h.toLowerCase());
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iId = col("participant_id", "participantid", "subject", "id");
  if (iId < 0) return out;
  const iAge = col("age", "age_years");
  const iSex = col("sex", "gender");
  const iAsa = col("asa", "asa_score", "asa_ps");
  const iAgent = col("anesthetic", "anaesthetic", "agent", "drug", "regimen", "anesthesia");

  for (const line of lines.slice(1)) {
    const cells = splitDelimited(line);
    const id = textOrNull(cells[iId]);
    if (!id) continue;
    const subject = id.startsWith("sub-") ? id : `sub-${id}`;
    const agentRaw = iAgent >= 0 ? textOrNull(cells[iAgent]) : null;
    out.set(subject, {
      subject,
      age: iAge >= 0 ? numOrNull(cells[iAge]) : null,
      sex: iSex >= 0 ? textOrNull(cells[iSex]) : null,
      asa: iAsa >= 0 ? textOrNull(cells[iAsa]) : null,
      agents: agentRaw
        ? agentRaw
            .split(/[;,+/]/)
            .map((a) => a.trim().toLowerCase())
            .filter(Boolean)
        : [],
    });
  }
  return out;
}

/**
 * Regimen in the app's vocabulary, from whatever agent names the record
 * publishes. Unknown or absent agents stay null rather than being guessed.
 */
export function regimenFromAgents(agents: string[]): string | null {
  const has = (...keys: string[]) => agents.some((a) => keys.some((k) => a.includes(k)));
  const propofol = has("propofol", "ppf", "diprivan");
  const opioid = has("remifentanil", "alfentanil", "fentanyl", "sufentanil", "opioid");
  const ketamine = has("ketamine");
  const volatile_ = has("sevoflurane", "desflurane", "isoflurane", "volatile");
  const dex = has("dexmedetomidine", "dex");
  if (propofol && ketamine) return "propofol_ketamine";
  if (propofol && opioid) return "propofol_opioid";
  if (propofol) return "propofol_tiva";
  if (volatile_) return opioid ? "volatile_opioid" : "volatile";
  if (dex) return "sedation_infusion";
  return null;
}

/* ---------------------------------------------------------------- physio -- */

export interface BidsPhysioMeta {
  columns: string[];
  samplingFrequency: number;
  startTime: number;
}

/** Parse a BIDS `_physio.json` sidecar. */
export function parseBidsPhysioJson(text: string): BidsPhysioMeta | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const columns = Array.isArray(raw["Columns"])
    ? (raw["Columns"] as unknown[]).map((c) => String(c))
    : [];
  const hz = Number(raw["SamplingFrequency"]);
  if (!columns.length || !Number.isFinite(hz) || hz <= 0) return null;
  const start = Number(raw["StartTime"]);
  return {
    columns,
    samplingFrequency: hz,
    startTime: Number.isFinite(start) ? start : 0,
  };
}

/** Column aliases across records, mapped onto the fields we keep. */
const FIELD_ALIASES: Record<string, string> = {
  bis: "bis",
  bis_index: "bis",
  bisindex: "bis",
  bis_value: "bis",
  depth: "bis",
  sef: "sef",
  sef95: "sef",
  bis_sef: "sef",
  spectral_edge: "sef",
  sr: "sr",
  bis_sr: "sr",
  suppression_ratio: "sr",
  emg: "emg",
  bis_emg: "emg",
  sqi: "sqi",
  bis_sqi: "sqi",
  signal_quality: "sqi",
  time: "time",
  onset: "time",
  seconds: "time",
  t: "time",
  timestamp: "time",
  ce_propofol: "ce:propofol",
  propofol_ce: "ce:propofol",
  ce_remifentanil: "ce:remifentanil",
  remifentanil_ce: "ce:remifentanil",
  ce_ketamine: "ce:ketamine",
  ce_alfentanil: "ce:alfentanil",
};

export interface MonitorSample {
  t: number;
  bis: number | null;
  sef: number | null;
  sr: number | null;
  emg: number | null;
  sqi: number | null;
  ce: Record<string, number>;
}

function blankSample(t: number): MonitorSample {
  return { t, bis: null, sef: null, sr: null, emg: null, sqi: null, ce: {} };
}

function assign(sample: MonitorSample, field: string, value: number): void {
  if (field.startsWith("ce:")) {
    sample.ce[field.slice(3)] = value;
    return;
  }
  if (field === "bis" || field === "sef" || field === "sr" || field === "emg" || field === "sqi") {
    sample[field] = value;
  }
}

/**
 * Decode a BIDS continuous physio table. The file itself is headerless — the
 * sidecar names the columns and supplies the sample clock.
 */
export function parsePhysioTable(text: string, meta: BidsPhysioMeta): MonitorSample[] {
  const fields = meta.columns.map((c) => FIELD_ALIASES[c.trim().toLowerCase()] ?? null);
  const iTime = fields.indexOf("time");
  const out: MonitorSample[] = [];
  const lines = text.split(/\r?\n/);
  let row = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = splitDelimited(line);
    // Tolerate a stray header row that repeats the sidecar column names.
    if (row === 0 && numOrNull(cells[0]) == null) continue;
    const t =
      iTime >= 0
        ? (numOrNull(cells[iTime]) ?? meta.startTime + row / meta.samplingFrequency)
        : meta.startTime + row / meta.samplingFrequency;
    const sample = blankSample(t);
    fields.forEach((f, i) => {
      if (!f || f === "time") return;
      const v = numOrNull(cells[i]);
      if (v != null) assign(sample, f, v);
    });
    out.push(sample);
    row++;
  }
  return out;
}

/**
 * Decode a plain per-case monitor table (TSV or CSV) whose first line names
 * the columns — the common shape when a record publishes BIS as a derivative.
 */
export function parseMonitorTable(text: string): MonitorSample[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const fields = splitDelimited(lines[0]!).map(
    (h) => FIELD_ALIASES[h.trim().toLowerCase()] ?? null,
  );
  if (!fields.includes("bis")) return [];
  const iTime = fields.indexOf("time");
  const out: MonitorSample[] = [];
  lines.slice(1).forEach((line, row) => {
    const cells = splitDelimited(line);
    const t = iTime >= 0 ? numOrNull(cells[iTime]) : row;
    if (t == null) return;
    const sample = blankSample(t);
    fields.forEach((f, i) => {
      if (!f || f === "time") return;
      const v = numOrNull(cells[i]);
      if (v != null) assign(sample, f, v);
    });
    out.push(sample);
  });
  return out;
}

/* --------------------------------------------------------------- mapping -- */

export interface OpenNeuroBisPoint {
  caseRef: string;
  atSeconds: number;
  bis: number;
  bisSef: number | null;
  bisSr: number | null;
  bisEmg: number | null;
  sqi: number | null;
  ce: Record<string, number>;
  externalRef: string;
}

export interface OpenNeuroBisMapping {
  datasetId: string;
  lineage: string;
  caseRef: string;
  covariates: VitalDbCovariates;
  points: OpenNeuroBisPoint[];
  rejected: { noBis: number; badRange: number; lowSqi: number };
}

export interface OpenNeuroBisOptions {
  strideSeconds?: number;
  minSqi?: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Subject/session identity from a BIDS filename. */
export function bisCaseRef(datasetId: string, fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  const sub = base.match(/sub-[A-Za-z0-9]+/)?.[0] ?? null;
  const ses = base.match(/ses-[A-Za-z0-9]+/)?.[0] ?? null;
  const id = normaliseDatasetId(datasetId);
  if (!sub) return `${id}-${base.replace(/\.[^.]+$/, "")}`;
  return ses ? `${id}-${sub}_${ses}` : `${id}-${sub}`;
}

export function subjectOf(fileName: string): string | null {
  return (fileName.split("/").pop() ?? fileName).match(/sub-[A-Za-z0-9]+/)?.[0] ?? null;
}

/**
 * Reduce a case's monitor samples to evenly spaced, quality-filtered reference
 * readings with whatever covariates the record actually publishes.
 */
export function mapOpenNeuroBisFile(
  datasetId: string,
  fileName: string,
  samples: MonitorSample[],
  participant: OpenNeuroParticipant | null,
  options: OpenNeuroBisOptions = {},
): OpenNeuroBisMapping {
  const stride = Math.max(1, options.strideSeconds ?? 10);
  const minSqi = options.minSqi ?? 50;
  const rejected = { noBis: 0, badRange: 0, lowSqi: 0 };

  const usable = samples.filter((s) => {
    if (s.bis == null) {
      rejected.noBis++;
      return false;
    }
    if (s.bis <= 0 || s.bis > 100) {
      rejected.badRange++;
      return false;
    }
    if (s.sqi != null && s.sqi < minSqi) {
      rejected.lowSqi++;
      return false;
    }
    return true;
  });

  const buckets = new Map<number, MonitorSample[]>();
  for (const s of usable) {
    const key = Math.floor(s.t / stride);
    const list = buckets.get(key);
    if (list) list.push(s);
    else buckets.set(key, [s]);
  }

  const usedCe = new Set<string>();
  for (const s of usable) for (const [d, v] of Object.entries(s.ce)) if (v > 0) usedCe.add(d);

  const id = normaliseDatasetId(datasetId);
  const caseRef = bisCaseRef(id, fileName);
  const points: OpenNeuroBisPoint[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, group]) => {
      const at = key * stride;
      const pick = (f: (s: MonitorSample) => number | null) =>
        median(group.map(f).filter((v): v is number => v != null));
      const ce: Record<string, number> = {};
      for (const drug of usedCe) {
        const v = median(
          group.map((s) => s.ce[drug]).filter((x): x is number => typeof x === "number"),
        );
        if (v != null) ce[drug] = Number(v.toFixed(3));
      }
      return {
        caseRef,
        atSeconds: at,
        bis: Number(pick((s) => s.bis)!.toFixed(1)),
        bisSef: pick((s) => s.sef),
        bisSr: pick((s) => s.sr),
        bisEmg: pick((s) => s.emg),
        sqi: pick((s) => s.sqi),
        ce,
        externalRef: `${OPENNEURO_BIS_SOURCE}:${id}:${caseRef}:${at}`,
      } satisfies OpenNeuroBisPoint;
    });

  const agents = participant?.agents ?? [];
  return {
    datasetId: id,
    lineage: openNeuroBisLineage(id),
    caseRef,
    covariates: {
      ageBand: ageBandOf(participant?.age ?? null),
      sex: sexOf(participant?.sex ?? null),
      regimen: regimenFromAgents([...agents, ...usedCe]),
      frailty: frailtyFromAsa(participant?.asa ?? null),
      asa: participant?.asa ?? null,
    },
    points,
    rejected,
  };
}
