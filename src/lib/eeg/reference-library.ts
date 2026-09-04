/**
 * Reference library — the label files this app will accept as ground truth.
 *
 * Every claim the app makes about depth, suppression or state is graded
 * against something recorded independently of it: a commercial BIS monitor's
 * export, a bedside MOAA/S observation sheet, or a dataset's event file
 * marking loss and return of consciousness. This module is the catalogue of
 * those formats — what each one must contain, what its numbers mean, which
 * published datasets it came from — and the parser that reads one in.
 *
 * Nothing here fabricates a reference value. Rows without a usable timestamp
 * and at least one reference measurement are reported as skipped, not filled.
 */

/** What kind of truth a file carries. */
/** Default acquisition lineage for user uploads: the headband setup. */
export const UPLOAD_LINEAGE_KEY = "muse-2|TP9-AF7-AF8-TP10|256";

export type ReferenceKind = "bis-monitor" | "sedation-scale" | "event-file";

export interface ReferenceColumn {
  name: string;
  required: boolean;
  meaning: string;
  units: string;
  /** Alternative header spellings accepted for this column. */
  aliases?: string[];
}

export interface ReferenceFormat {
  id: string;
  label: string;
  kind: ReferenceKind;
  /** Where this format is already in use in the app's pooled data. */
  provenance: string;
  /** Whether the time column is seconds from the start or a wall clock. */
  timeBase: "seconds" | "clock";
  columns: ReferenceColumn[];
  licence: string;
  licenceUrl: string | null;
  /** What the file can and cannot be used to grade. */
  notes: string;
  /** A header line and one row, shown so a file can be shaped to match. */
  sample: string;
}

export const REFERENCE_KIND_LABEL: Record<ReferenceKind, string> = {
  "bis-monitor": "BIS monitor export",
  "sedation-scale": "Sedation score sheet",
  "event-file": "Event / annotation file",
};

const TIME_ALIASES = ["time", "t", "seconds", "sec", "onset", "timestamp", "at", "at_seconds"];

export const REFERENCE_FORMATS: ReferenceFormat[] = [
  {
    id: "vitaldb-bis",
    label: "VitalDB BIS track export",
    kind: "bis-monitor",
    provenance: "VitalDB intraoperative recordings — the app's largest paired set.",
    timeBase: "seconds",
    columns: [
      { name: "time", required: true, meaning: "Seconds from the start of the recording", units: "s", aliases: TIME_ALIASES },
      { name: "bis", required: true, meaning: "Displayed BIS index", units: "0–100", aliases: ["bis/bis", "bis_value", "index"] },
      { name: "sr", required: false, meaning: "Suppression ratio shown by the monitor", units: "%", aliases: ["bis/sr", "sr%", "suppression_ratio"] },
      { name: "sef", required: false, meaning: "Spectral edge frequency", units: "Hz", aliases: ["bis/sef", "sef95", "sef_95"] },
      { name: "emg", required: false, meaning: "Electromyograph power", units: "dB", aliases: ["bis/emg"] },
      { name: "sqi", required: false, meaning: "Signal quality index; readings below 50 are not used for fitting", units: "0–100", aliases: ["bis/sqi", "quality"] },
    ],
    licence: "CC BY 4.0, registered users",
    licenceUrl: "https://vitaldb.net/dataset/",
    notes:
      "The monitor's own suppression ratio and spectral edge come with the index, so one file grades depth, suppression and spectral edge together.",
    sample: "time,bis,sr,sef,sqi\n1830,42,0,11.4,97",
  },
  {
    id: "generic-bis",
    label: "Your own monitor export",
    kind: "bis-monitor",
    provenance: "Anything you export from the theatre or ICU monitor, in seconds and index columns.",
    timeBase: "seconds",
    columns: [
      { name: "time", required: true, meaning: "Seconds from the start of the recording", units: "s", aliases: TIME_ALIASES },
      { name: "bis", required: true, meaning: "Displayed depth index", units: "0–100", aliases: ["index", "value", "depth"] },
      { name: "sr", required: false, meaning: "Suppression ratio", units: "%", aliases: ["suppression", "suppression_ratio"] },
      { name: "sef", required: false, meaning: "Spectral edge frequency", units: "Hz", aliases: ["sef95"] },
      { name: "sqi", required: false, meaning: "Signal quality index", units: "0–100", aliases: ["quality"] },
    ],
    licence: "Yours — stays in your account",
    licenceUrl: null,
    notes:
      "Every row is matched to the nearest scored moment in the recording you attach it to; rows more than 15 seconds from any scored moment are skipped rather than stretched.",
    sample: "time,bis,sr,sef\n600,38,2,10.8",
  },
  {
    id: "figshare-ma-bis",
    label: "Figshare MA-BIS case file",
    kind: "bis-monitor",
    provenance: "Figshare 5589841 surgical cases — the set that fitted the app's second live model.",
    timeBase: "seconds",
    columns: [
      { name: "time", required: true, meaning: "Seconds from the start of the case", units: "s", aliases: TIME_ALIASES },
      { name: "bis", required: true, meaning: "BIS index", units: "0–100", aliases: ["bis_value"] },
      { name: "sef", required: false, meaning: "Spectral edge frequency", units: "Hz", aliases: ["sef95"] },
    ],
    licence: "CC BY 4.0",
    licenceUrl: "https://doi.org/10.6084/m9.figshare.5589841",
    notes: "Index only — carries no suppression ratio, so it grades depth but not burst suppression.",
    sample: "time,bis,sef\n2400,45,12.1",
  },
  {
    id: "dose1-moaas",
    label: "DOSE-I pEEG sedation file",
    kind: "sedation-scale",
    provenance: "Zenodo DOSE-I propofol sedation study — the app's MOAA/S-graded set.",
    timeBase: "clock",
    columns: [
      { name: "time", required: true, meaning: "Wall clock of the observation", units: "timestamp", aliases: TIME_ALIASES },
      { name: "moaas", required: true, meaning: "Modified Observer's Assessment of Alertness/Sedation, 5 awake to 0 unresponsive", units: "0–5", aliases: ["moaa/s", "moaas_score", "sedation"] },
      { name: "propofol", required: false, meaning: "Propofol dose in force at the observation", units: "mg", aliases: [] },
      { name: "sef95", required: false, meaning: "Spectral edge published with the observation", units: "Hz", aliases: ["sef"] },
    ],
    licence: "CC BY 4.0",
    licenceUrl: "https://doi.org/10.5281/zenodo.7770194",
    notes:
      "MOAA/S is an observation, not a monitor reading: 5 reads as awake, 3–4 as sedated, 2 and below as anaesthetised. It grades state, never a numeric index.",
    sample: "time,moaas,propofol\n2026-03-02T09:14:00Z,3,60",
  },
  {
    id: "generic-moaas",
    label: "Your own MOAA/S observation sheet",
    kind: "sedation-scale",
    provenance: "Bedside sedation scoring written up alongside one of your recordings.",
    timeBase: "seconds",
    columns: [
      { name: "time", required: true, meaning: "Seconds from the start of the recording", units: "s", aliases: TIME_ALIASES },
      { name: "moaas", required: true, meaning: "MOAA/S score at that moment", units: "0–5", aliases: ["moaa/s", "sedation", "score"] },
      { name: "note", required: false, meaning: "Anything observed alongside the score", units: "text", aliases: ["comment", "detail"] },
    ],
    licence: "Yours — stays in your account",
    licenceUrl: null,
    notes:
      "Each score becomes a state label over the interval up to the next score, so a sheet of six observations grades the whole recording.",
    sample: "time,moaas,note\n480,2,after induction bolus",
  },
  {
    id: "bids-events",
    label: "BIDS events file",
    kind: "event-file",
    provenance: "OpenNeuro ds004541 — the app's awake versus anaesthetised comparison set.",
    timeBase: "seconds",
    columns: [
      { name: "onset", required: true, meaning: "Seconds from the start of the recording", units: "s", aliases: TIME_ALIASES },
      { name: "trial_type", required: true, meaning: "State marker: awake, induction, anaesthetised or emergence", units: "text", aliases: ["state", "label", "value", "event", "condition"] },
      { name: "duration", required: false, meaning: "How long the marked state lasted", units: "s", aliases: [] },
    ],
    licence: "CC0 1.0",
    licenceUrl: "https://openneuro.org/datasets/ds004541",
    notes:
      "Markers are taken at face value: loss and return of consciousness bracket the anaesthetised interval, and unrecognised markers are reported rather than guessed at.",
    sample: "onset\tduration\ttrial_type\n1204\t3600\tanaesthetised",
  },
  {
    id: "generic-events",
    label: "Your own event list",
    kind: "event-file",
    provenance: "Induction, loss of consciousness, emergence and other markers noted during your case.",
    timeBase: "seconds",
    columns: [
      { name: "onset", required: true, meaning: "Seconds from the start of the recording", units: "s", aliases: TIME_ALIASES },
      { name: "trial_type", required: true, meaning: "State at that moment", units: "text", aliases: ["state", "label", "event"] },
      { name: "duration", required: false, meaning: "How long it lasted", units: "s", aliases: [] },
    ],
    licence: "Yours — stays in your account",
    licenceUrl: null,
    notes: "Markers become state labels on the recording you attach them to, and are graded like any dataset label.",
    sample: "onset,duration,trial_type\n905,15,induction",
  },
];

export function formatById(id: string): ReferenceFormat | undefined {
  return REFERENCE_FORMATS.find((f) => f.id === id);
}

/** Recognised state words, mapped onto the app's shared vocabulary. */
export function normaliseState(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!s) return null;
  if (["awake", "baseline", "eyesopen", "eyesclosed", "preinduction", "roc", "returnofconsciousness"].includes(s))
    return "awake";
  if (["induction", "loc", "lossofconsciousness", "inducing"].includes(s)) return "induction";
  if (["anaesthetised", "anesthetised", "anesthetized", "maintenance", "surgery", "deep", "general"].includes(s))
    return "anaesthetised";
  if (["emergence", "emerging", "wakeup", "recovery"].includes(s)) return "emergence";
  if (["sedated", "sedation", "light"].includes(s)) return "sedated";
  return null;
}

/** MOAA/S onto the same vocabulary: 5 awake, 3–4 sedated, 2 and below under. */
export function stateFromMoaas(score: number): string {
  if (score >= 5) return "awake";
  if (score >= 3) return "sedated";
  return "anaesthetised";
}

export interface ReferenceRow {
  /** Seconds from the start of the recording. */
  at: number;
  bis: number | null;
  sr: number | null;
  sef: number | null;
  sqi: number | null;
  moaas: number | null;
  state: string | null;
  duration: number | null;
}

export interface ParsedReferenceFile {
  formatId: string;
  kind: ReferenceKind;
  rows: ReferenceRow[];
  /** Rows dropped, with the reason, so nothing disappears silently. */
  skipped: { reason: string; count: number }[];
  /** Header names present in the file that the format does not use. */
  unusedColumns: string[];
  /** Required columns that were not found. */
  missingColumns: string[];
}

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function detectDelimiter(header: string): string {
  const counts = [",", "\t", ";"].map((d) => ({ d, n: header.split(d).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 1 ? counts[0]!.d : ",";
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clockSeconds(v: string | undefined): number | null {
  if (!v) return null;
  const ms = Date.parse(v.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z"));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Which format best matches a header line, by how many of its columns appear. */
export function detectFormat(headerLine: string): ReferenceFormat | null {
  const delim = detectDelimiter(headerLine);
  const headers = splitLine(headerLine, delim).map((h) => h.toLowerCase());
  let best: { format: ReferenceFormat; score: number } | null = null;
  for (const format of REFERENCE_FORMATS) {
    let score = 0;
    let missingRequired = false;
    for (const col of format.columns) {
      const names = [col.name.toLowerCase(), ...(col.aliases ?? []).map((a) => a.toLowerCase())];
      const found = headers.some((h) => names.includes(h));
      if (found) score += col.required ? 3 : 1;
      else if (col.required) missingRequired = true;
    }
    if (missingRequired) continue;
    if (!best || score > best.score) best = { format, score };
  }
  return best?.format ?? null;
}

/** Read a reference file into rows the app can grade against. */
export function parseReferenceFile(format: ReferenceFormat, text: string): ParsedReferenceFile {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const result: ParsedReferenceFile = {
    formatId: format.id,
    kind: format.kind,
    rows: [],
    skipped: [],
    unusedColumns: [],
    missingColumns: [],
  };
  if (lines.length < 2) {
    result.missingColumns = format.columns.filter((c) => c.required).map((c) => c.name);
    return result;
  }

  const delim = detectDelimiter(lines[0]!);
  const headers = splitLine(lines[0]!, delim).map((h) => h.toLowerCase());
  const index = (col: ReferenceColumn) => {
    const names = [col.name.toLowerCase(), ...(col.aliases ?? []).map((a) => a.toLowerCase())];
    return headers.findIndex((h) => names.includes(h));
  };
  const idx = new Map<string, number>();
  const used = new Set<number>();
  for (const col of format.columns) {
    const i = index(col);
    idx.set(col.name, i);
    if (i >= 0) used.add(i);
    else if (col.required) result.missingColumns.push(col.name);
  }
  result.unusedColumns = headers.filter((_, i) => !used.has(i));
  if (result.missingColumns.length) return result;

  const at = (row: string[], name: string) => {
    const i = idx.get(name) ?? -1;
    return i >= 0 ? row[i] : undefined;
  };
  const skips = new Map<string, number>();
  const skip = (reason: string) => skips.set(reason, (skips.get(reason) ?? 0) + 1);

  let base: number | null = null;
  for (const line of lines.slice(1)) {
    const row = splitLine(line, delim);
    const timeCol = format.columns[0]!.name;
    const rawTime = at(row, timeCol);
    let seconds: number | null;
    if (format.timeBase === "clock") {
      const abs = clockSeconds(rawTime) ?? num(rawTime);
      if (abs == null) {
        skip("no readable time");
        continue;
      }
      base ??= abs;
      seconds = abs - base;
    } else {
      seconds = num(rawTime);
    }
    if (seconds == null || seconds < 0) {
      skip("no readable time");
      continue;
    }

    const bis = num(at(row, "bis"));
    const moaas = num(at(row, "moaas"));
    const rawState = at(row, "trial_type");
    const state =
      moaas != null
        ? stateFromMoaas(moaas)
        : rawState != null
          ? normaliseState(rawState)
          : null;

    if (bis != null && (bis < 0 || bis > 100)) {
      skip("index outside 0–100");
      continue;
    }
    if (moaas != null && (moaas < 0 || moaas > 5)) {
      skip("MOAA/S outside 0–5");
      continue;
    }
    if (format.kind === "event-file" && rawState != null && rawState.trim() !== "" && state == null) {
      skip(`unrecognised marker "${rawState.trim()}"`);
      continue;
    }
    if (bis == null && moaas == null && state == null) {
      skip("no reference value on the row");
      continue;
    }

    result.rows.push({
      at: Number(seconds.toFixed(2)),
      bis,
      sr: num(at(row, "sr")),
      sef: num(at(row, "sef")) ?? num(at(row, "sef95")),
      sqi: num(at(row, "sqi")),
      moaas,
      state,
      duration: num(at(row, "duration")),
    });
  }

  result.skipped = [...skips.entries()].map(([reason, count]) => ({ reason, count }));
  return result;
}
