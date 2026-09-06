/**
 * Bringing the hospital's own record of what happened into the app.
 *
 * There is no live link to a hospital record system here, and deliberately so:
 * the app never reaches into patient records, and no identifiers are accepted.
 * Instead a discharge/recovery export is matched to recordings by the case code
 * the anaesthetist filed, one row per case. Everything is checked and shown
 * before anything is written, and rows that do not match a recording are left
 * alone rather than guessed at.
 */

import { DELIRIUM_OPTIONS, EMERGENCE_OPTIONS, type OutcomeCase } from "./outcomes";

export interface OutcomeImportRow {
  caseCode: string;
  delirium: string;
  deliriumDays: number | null;
  emergence: string;
  awareness: boolean;
  unplannedIcu: boolean;
  mortality30d: boolean;
  lengthOfStayDays: number | null;
  notes: string | null;
}

export interface OutcomeImportParse {
  rows: OutcomeImportRow[];
  /** Human-readable problems, one per rejected row or unknown column. */
  issues: string[];
  /** Columns in the file that the app does not use. */
  ignoredColumns: string[];
}

/** Anything that looks like a patient identifier is refused outright. */
const IDENTIFIER_COLUMNS = [
  "nhs",
  "nhs_number",
  "mrn",
  "hospital_number",
  "patient_id",
  "name",
  "surname",
  "first_name",
  "last_name",
  "dob",
  "date_of_birth",
  "address",
  "postcode",
];

const KNOWN_COLUMNS = [
  "case_code",
  "case",
  "delirium",
  "delirium_days",
  "emergence",
  "awareness",
  "unplanned_icu",
  "icu",
  "mortality_30d",
  "death_30d",
  "length_of_stay_days",
  "los_days",
  "notes",
];

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
    else if (ch === "," || ch === "\t") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

const truthy = (v: string | undefined): boolean => {
  const t = (v ?? "").trim().toLowerCase();
  return t === "1" || t === "y" || t === "yes" || t === "true";
};

const num = (v: string | undefined): number | null => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Map free text onto the app's own option keys, falling back to unknown. */
function matchOption(value: string | undefined, options: readonly { key: string; label: string }[]) {
  const t = (value ?? "").trim().toLowerCase();
  if (!t) return "unknown";
  const byKey = options.find((o) => o.key === t);
  if (byKey) return byKey.key;
  const byLabel = options.find((o) => o.label.toLowerCase() === t);
  if (byLabel) return byLabel.key;
  // "delirium", "yes", "present" all mean delirium of unspecified type.
  if (options === DELIRIUM_OPTIONS) {
    if (t === "no" || t === "none" || t === "absent") return "none";
    if (t === "yes" || t === "present" || t === "delirium") return "mixed";
  }
  return "unknown";
}

/**
 * Parse a recovery/discharge export. Delimiter may be comma or tab; header
 * names are matched case-insensitively and a few common aliases are accepted.
 */
export function parseOutcomeExportCsv(text: string): OutcomeImportParse {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const issues: string[] = [];
  if (!lines.length) return { rows: [], issues: ["The file is empty."], ignoredColumns: [] };

  const header = splitCsvLine(lines[0]!).map((h) =>
    h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_"),
  );

  const banned = header.filter((h) => IDENTIFIER_COLUMNS.includes(h));
  if (banned.length) {
    return {
      rows: [],
      issues: [
        `The file contains patient identifiers (${banned.join(", ")}). Remove those columns and export again — this app never stores them.`,
      ],
      ignoredColumns: [],
    };
  }

  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iCase = col("case_code", "case");
  if (iCase < 0) {
    return {
      rows: [],
      issues: ["No case_code column found — the export needs one column holding the case code."],
      ignoredColumns: [],
    };
  }

  const idx = {
    delirium: col("delirium"),
    deliriumDays: col("delirium_days"),
    emergence: col("emergence"),
    awareness: col("awareness"),
    icu: col("unplanned_icu", "icu"),
    death: col("mortality_30d", "death_30d"),
    los: col("length_of_stay_days", "los_days"),
    notes: col("notes"),
  };
  const at = (r: string[], i: number) => (i >= 0 ? r[i] : undefined);

  const ignoredColumns = header.filter((h) => h && !KNOWN_COLUMNS.includes(h));
  const seen = new Set<string>();
  const rows: OutcomeImportRow[] = [];

  lines.slice(1).forEach((line, n) => {
    const r = splitCsvLine(line);
    const caseCode = (r[iCase] ?? "").trim();
    if (!caseCode) {
      issues.push(`Row ${n + 2}: no case code, skipped.`);
      return;
    }
    if (seen.has(caseCode)) {
      issues.push(`Row ${n + 2}: case ${caseCode} appears twice, only the first is used.`);
      return;
    }
    seen.add(caseCode);
    rows.push({
      caseCode,
      delirium: matchOption(at(r, idx.delirium), DELIRIUM_OPTIONS),
      deliriumDays: num(at(r, idx.deliriumDays)),
      emergence: matchOption(at(r, idx.emergence), EMERGENCE_OPTIONS),
      awareness: truthy(at(r, idx.awareness)),
      unplannedIcu: truthy(at(r, idx.icu)),
      mortality30d: truthy(at(r, idx.death)),
      lengthOfStayDays: num(at(r, idx.los)),
      notes: (at(r, idx.notes) || "").trim() || null,
    });
  });

  return { rows, issues, ignoredColumns };
}

/* ---------------------------------------------------------------- match --- */

export interface OutcomeMatch {
  row: OutcomeImportRow;
  sessionId: string;
  caseCode: string;
  /** True when this case already has an outcome that the import would replace. */
  replaces: boolean;
}

export interface OutcomeMatchReport {
  matched: OutcomeMatch[];
  /** Case codes in the file with no recording in the app. */
  unmatched: string[];
  /** Recordings still without an outcome after this import. */
  stillMissing: string[];
}

/** Match export rows to filed recordings by case code, ignoring case and spaces. */
export function matchOutcomeRows(
  rows: OutcomeImportRow[],
  cases: OutcomeCase[],
): OutcomeMatchReport {
  const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
  const byCode = new Map(cases.map((c) => [key(c.caseCode), c]));
  const matched: OutcomeMatch[] = [];
  const unmatched: string[] = [];

  for (const row of rows) {
    const found = byCode.get(key(row.caseCode));
    if (!found) {
      unmatched.push(row.caseCode);
      continue;
    }
    matched.push({
      row,
      sessionId: found.sessionId,
      caseCode: found.caseCode,
      replaces: found.outcome != null,
    });
  }

  const filled = new Set(matched.map((m) => m.sessionId));
  const stillMissing = cases
    .filter((c) => !c.outcome && !filled.has(c.sessionId))
    .map((c) => c.caseCode);

  return { matched, unmatched, stillMissing };
}
