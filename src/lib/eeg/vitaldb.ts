/**
 * VitalDB import — mapping an open perioperative dataset onto the covariate
 * layer COEBIS learns from.
 *
 * VitalDB (https://vitaldb.net) publishes 6,388 surgical cases with
 * high-resolution intraoperative monitor tracks and per-case clinical fields.
 * Two files are needed:
 *
 *   1. the clinical table   https://api.vitaldb.net/cases            (all cases)
 *   2. a case's tracks      https://api.vitaldb.net/{caseid}?tracks=BIS/BIS,...
 *
 * What it can and cannot do for the model is deliberately explicit. VitalDB
 * carries the *commercial* BIS numerics (BIS, SEF, SR, EMG, SQI) and the pump
 * effect-site concentrations, but no frontal EEG this app could process. So a
 * VitalDB reading is not a paired reading: there is no app index to align to,
 * and it must never enter `bis_paired_points`, which would fit the alignment
 * against itself. It is stored separately as external reference data and used
 * for the population layer — what BIS a monitor typically reads at a given
 * effect-site concentration for a given age, sex and regimen — which is the
 * prior the per-clinician paired readings then personalise.
 */

import { AGE_BANDS } from "./covariates";

/** Lineage key every VitalDB-derived row is filed under. */
export const VITALDB_LINEAGE = "external:vitaldb";
export const VITALDB_SOURCE = "vitaldb";

/** Track names as VitalDB publishes them, mapped to the fields we keep. */
const TRACK_ALIASES: Record<string, string> = {
  "bis/bis": "bis",
  bis: "bis",
  "bis/sef": "sef",
  sef: "sef",
  "bis/sr": "sr",
  sr: "sr",
  "bis/emg": "emg",
  emg: "emg",
  "bis/sqi": "sqi",
  sqi: "sqi",
  "orchestra/ppf20_ce": "propofol",
  "orchestra/ppf20_ce(mcg/ml)": "propofol",
  "orchestra/rftn20_ce": "remifentanil",
  "orchestra/rftn50_ce": "remifentanil",
  "orchestra/aft20_ce": "alfentanil",
  "orchestra/ket20_ce": "ketamine",
  time: "time",
};

export interface VitalDbTrackSample {
  /** Seconds from the start of the case. */
  t: number;
  bis: number | null;
  sef: number | null;
  sr: number | null;
  emg: number | null;
  sqi: number | null;
  ce: Record<string, number>;
}

export interface VitalDbCaseInfo {
  caseId: string;
  age: number | null;
  sex: string | null;
  asa: string | null;
  aneType: string | null;
  /** Whether the clinical table records a propofol infusion for the case. */
  propofol: boolean;
  opioid: boolean;
}

/** Covariates in the app's own vocabulary, derived from a VitalDB case row. */
export interface VitalDbCovariates {
  ageBand: string | null;
  sex: string | null;
  regimen: string | null;
  frailty: string | null;
  asa: string | null;
}

export interface VitalDbPoint {
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

export interface VitalDbMapping {
  caseRef: string;
  covariates: VitalDbCovariates;
  points: VitalDbPoint[];
  /** Samples dropped, with the reason, so the import is never silently lossy. */
  rejected: { noBis: number; badRange: number; lowSqi: number };
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
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  return { header, rows: lines.slice(1).map(splitCsvLine) };
}

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------- mapping --- */

export function ageBandOf(age: number | null): string | null {
  if (age == null || !Number.isFinite(age)) return null;
  if (age < 18) return AGE_BANDS[0];
  if (age < 40) return AGE_BANDS[1];
  if (age < 60) return AGE_BANDS[2];
  if (age < 75) return AGE_BANDS[3];
  if (age < 90) return AGE_BANDS[4];
  return AGE_BANDS[5];
}

export function sexOf(raw: string | null): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "m" || v === "male") return "male";
  if (v === "f" || v === "female") return "female";
  return null;
}

/**
 * ASA is not frailty, but it is the only proximate marker VitalDB publishes.
 * The mapping is coarse and is labelled as derived wherever it is shown.
 */
export function frailtyFromAsa(asa: string | null): string | null {
  const n = Number((asa ?? "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 2) return "fit";
  if (n === 3) return "mild";
  if (n === 4) return "moderate";
  return "severe";
}

/**
 * Regimen is inferred from the anaesthetic type plus whether propofol and an
 * opioid were actually running, since VitalDB has no regimen field.
 */
export function regimenOf(info: VitalDbCaseInfo, usedCe: Set<string>): string | null {
  const ane = (info.aneType ?? "").toLowerCase();
  const propofol = info.propofol || usedCe.has("propofol");
  const opioid =
    info.opioid || usedCe.has("remifentanil") || usedCe.has("alfentanil");
  const ketamine = usedCe.has("ketamine");
  if (ane.includes("sedation")) return "sedation_infusion";
  if (ane.includes("spinal") || ane.includes("regional")) return "other";
  if (propofol && ketamine) return "propofol_ketamine";
  if (propofol && opioid) return "propofol_opioid";
  if (propofol) return "propofol_tiva";
  if (ane.includes("general")) return opioid ? "volatile_opioid" : "volatile";
  return null;
}

/* --------------------------------------------------------------- parse --- */

/** Parse the VitalDB clinical table, keyed by case id. */
export function parseVitalDbClinicalCsv(text: string): Map<string, VitalDbCaseInfo> {
  const { header, rows } = parseCsv(text);
  const col = (name: string) => header.indexOf(name);
  const iCase = col("caseid");
  const out = new Map<string, VitalDbCaseInfo>();
  if (iCase < 0) return out;
  const iAge = col("age");
  const iSex = col("sex");
  const iAsa = col("asa");
  const iAne = col("ane_type");
  const iPpf = col("intraop_ppf");
  const iFtn = col("intraop_ftn");
  for (const r of rows) {
    const caseId = r[iCase]?.trim();
    if (!caseId) continue;
    out.set(caseId, {
      caseId,
      age: iAge >= 0 ? num(r[iAge]) : null,
      sex: iSex >= 0 ? (r[iSex] ?? null) : null,
      asa: iAsa >= 0 ? (r[iAsa] || null) : null,
      aneType: iAne >= 0 ? (r[iAne] || null) : null,
      propofol: iPpf >= 0 ? (num(r[iPpf]) ?? 0) > 0 : false,
      opioid: iFtn >= 0 ? (num(r[iFtn]) ?? 0) > 0 : false,
    });
  }
  return out;
}

/** Parse a VitalDB per-case track export into normalised samples. */
export function parseVitalDbTrackCsv(text: string): VitalDbTrackSample[] {
  const { header, rows } = parseCsv(text);
  if (!header.length) return [];
  const fields = header.map((h) => TRACK_ALIASES[h] ?? null);
  const iTime = fields.indexOf("time");
  const samples: VitalDbTrackSample[] = [];
  for (const r of rows) {
    const t = iTime >= 0 ? num(r[iTime]) : samples.length;
    if (t == null) continue;
    const s: VitalDbTrackSample = {
      t,
      bis: null,
      sef: null,
      sr: null,
      emg: null,
      sqi: null,
      ce: {},
    };
    fields.forEach((f, i) => {
      if (!f || f === "time") return;
      const v = num(r[i]);
      if (v == null) return;
      if (f === "bis" || f === "sef" || f === "sr" || f === "emg" || f === "sqi") {
        s[f] = v;
      } else {
        s.ce[f] = v;
      }
    });
    samples.push(s);
  }
  return samples;
}

export interface MapOptions {
  /** One retained reading per this many seconds of case time. */
  strideSeconds?: number;
  /** Readings below this BIS signal-quality index are discarded. */
  minSqi?: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Reduce a case's raw monitor tracks to evenly spaced, quality-filtered
 * reference readings with covariates attached.
 */
export function mapVitalDbCase(
  info: VitalDbCaseInfo,
  samples: VitalDbTrackSample[],
  options: MapOptions = {},
): VitalDbMapping {
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

  const buckets = new Map<number, VitalDbTrackSample[]>();
  for (const s of usable) {
    const key = Math.floor(s.t / stride);
    const list = buckets.get(key);
    if (list) list.push(s);
    else buckets.set(key, [s]);
  }

  const usedCe = new Set<string>();
  for (const s of usable) {
    for (const [drug, v] of Object.entries(s.ce)) if (v > 0) usedCe.add(drug);
  }

  const caseRef = `vitaldb-${info.caseId}`;
  const points: VitalDbPoint[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, group]) => {
      const at = key * stride;
      const pick = (f: (s: VitalDbTrackSample) => number | null) =>
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
        externalRef: `${VITALDB_SOURCE}:${info.caseId}:${at}`,
      } satisfies VitalDbPoint;
    });

  return {
    caseRef,
    covariates: {
      ageBand: ageBandOf(info.age),
      sex: sexOf(info.sex),
      regimen: regimenOf(info, usedCe),
      frailty: frailtyFromAsa(info.asa),
      asa: info.asa,
    },
    points,
    rejected,
  };
}

/* ------------------------------------------------------------- summary --- */

export interface PriorGroup {
  group: string;
  level: string;
  n: number;
  cases: number;
  meanBis: number;
  /** Mean modelled propofol effect-site concentration, where recorded. */
  meanPropofolCe: number | null;
}

export interface ExternalPriorSummary {
  points: number;
  cases: number;
  groups: PriorGroup[];
}

interface PriorRow {
  caseRef: string;
  bis: number;
  ce: Record<string, number> | null;
  ageBand: string | null;
  sex: string | null;
  regimen: string | null;
  frailty: string | null;
}

/**
 * What the external pool actually says: mean commercial BIS per covariate
 * level, with the case count so a level backed by two patients is visible as
 * such rather than quietly treated as a population truth.
 */
export function summariseExternalPriors(rows: PriorRow[]): ExternalPriorSummary {
  const acc = new Map<string, { sum: number; n: number; ce: number[]; cases: Set<string> }>();
  for (const r of rows) {
    const entries: [string, string | null][] = [
      ["age", r.ageBand],
      ["sex", r.sex],
      ["regimen", r.regimen],
      ["frailty", r.frailty],
    ];
    for (const [group, level] of entries) {
      if (!level) continue;
      const key = `${group}|${level}`;
      const cur = acc.get(key) ?? { sum: 0, n: 0, ce: [] as number[], cases: new Set<string>() };
      cur.sum += r.bis;
      cur.n += 1;
      cur.cases.add(r.caseRef);
      const ppf = r.ce?.["propofol"];
      if (typeof ppf === "number" && ppf > 0) cur.ce.push(ppf);
      acc.set(key, cur);
    }
  }
  const groups: PriorGroup[] = [...acc.entries()]
    .map(([key, v]) => {
      const [group, level] = key.split("|") as [string, string];
      return {
        group,
        level,
        n: v.n,
        cases: v.cases.size,
        meanBis: Number((v.sum / v.n).toFixed(1)),
        meanPropofolCe: v.ce.length
          ? Number((v.ce.reduce((a, b) => a + b, 0) / v.ce.length).toFixed(2))
          : null,
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || b.n - a.n);
  return {
    points: rows.length,
    cases: new Set(rows.map((r) => r.caseRef)).size,
    groups,
  };
}
