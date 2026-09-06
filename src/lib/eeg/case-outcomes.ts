/**
 * Confirmed clinical outcomes paired with intra-operative depth exposure.
 *
 * The point of this module is to let the models be graded against what
 * actually happened to the patient — died in hospital, needed intensive care,
 * stayed longer — rather than only against another monitor's number.
 *
 * Outcomes come from the source registry's own clinical table. They are never
 * inferred from the EEG, and never written by a model.
 */

/* ------------------------------------------------------------- outcomes --- */

export interface CaseOutcome {
  caseRef: string;
  inHospitalDeath: boolean | null;
  icuDays: number | null;
  hospitalDays: number | null;
  emergency: boolean | null;
  asa: string | null;
  ageYears: number | null;
  sex: string | null;
  department: string | null;
  optype: string | null;
  approach: string | null;
  comorbidities: string[];
}

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

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const flag = (v: string | undefined): boolean | null => {
  const n = num(v);
  if (n != null) return n > 0;
  const t = (v ?? "").trim().toLowerCase();
  if (t === "y" || t === "yes" || t === "true") return true;
  if (t === "n" || t === "no" || t === "false") return false;
  return null;
};

/** Days between two VitalDB day-offset stamps, when both are present. */
function spanDays(from: number | null, to: number | null): number | null {
  if (from == null || to == null) return null;
  const days = (to - from) / 86400;
  return Number.isFinite(days) && days >= 0 ? Math.round(days * 10) / 10 : null;
}

/**
 * Parse the VitalDB clinical table into outcome rows, keyed by case ref.
 * Unknown or blank fields stay null rather than being defaulted to zero — a
 * missing ICU record is not the same as no ICU stay.
 */
export function parseVitalDbOutcomeCsv(text: string): Map<string, CaseOutcome> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out = new Map<string, CaseOutcome>();
  if (!lines.length) return out;
  const header = splitCsvLine(lines[0]!).map((h) =>
    h.replace(/^\uFEFF/, "").toLowerCase(),
  );
  const col = (name: string) => header.indexOf(name);
  const iCase = col("caseid");
  if (iCase < 0) return out;

  const idx = {
    icu: col("icu_days"),
    death: col("death_inhosp"),
    adm: col("adm"),
    dis: col("dis"),
    emop: col("emop"),
    asa: col("asa"),
    age: col("age"),
    sex: col("sex"),
    dept: col("department"),
    optype: col("optype"),
    approach: col("approach"),
    htn: col("preop_htn"),
    dm: col("preop_dm"),
  };
  const at = (r: string[], i: number) => (i >= 0 ? r[i] : undefined);

  for (const line of lines.slice(1)) {
    const r = splitCsvLine(line);
    const caseId = r[iCase]?.trim();
    if (!caseId) continue;
    const comorbidities: string[] = [];
    if (flag(at(r, idx.htn))) comorbidities.push("hypertension");
    if (flag(at(r, idx.dm))) comorbidities.push("diabetes");
    out.set(caseId, {
      caseRef: `vitaldb-${caseId}`,
      inHospitalDeath: flag(at(r, idx.death)),
      icuDays: num(at(r, idx.icu)),
      hospitalDays: spanDays(num(at(r, idx.adm)), num(at(r, idx.dis))),
      emergency: flag(at(r, idx.emop)),
      asa: at(r, idx.asa) || null,
      ageYears: num(at(r, idx.age)),
      sex: (at(r, idx.sex) || null)?.toLowerCase() ?? null,
      department: at(r, idx.dept) || null,
      optype: at(r, idx.optype) || null,
      approach: at(r, idx.approach) || null,
      comorbidities,
    });
  }
  return out;
}

/* ------------------------------------------------------------- exposure --- */

export interface DepthReading {
  atSeconds: number;
  /** Depth index at this moment: recorded monitor value or the app's index. */
  index: number;
  /** Suppression ratio in percent, when the source records one. */
  suppressionRatio?: number | null;
}

export interface DepthExposure {
  caseRef: string;
  readings: number;
  /** Anaesthetic time covered by the readings, in minutes. */
  minutes: number;
  meanIndex: number;
  minIndex: number;
  /** Minutes spent below the usual lower bound of the surgical range. */
  minutesBelow40: number;
  /** Minutes spent deeply suppressed on the index alone. */
  minutesBelow30: number;
  /** Minutes above the surgical range — the light end. */
  minutesAbove60: number;
  /** Minutes with a recorded suppression ratio above zero. */
  minutesSuppressed: number;
  /** Share of the case below 40, 0-1. Comparable across cases of any length. */
  fractionBelow40: number;
  fractionBelow30: number;
  fractionSuppressed: number;
}

/** Longest gap that still counts as continuous monitoring, in seconds. */
const MAX_GAP_SECONDS = 30;

/**
 * Turn a case's readings into time-weighted exposure. Each reading carries the
 * interval up to the next one, so an irregular sampling rate does not silently
 * over-weight the busy stretches.
 */
export function depthExposureOf(
  caseRef: string,
  readings: DepthReading[],
): DepthExposure | null {
  const rows = readings
    .filter((r) => Number.isFinite(r.atSeconds) && Number.isFinite(r.index))
    .sort((a, b) => a.atSeconds - b.atSeconds);
  if (!rows.length) return null;

  let seconds = 0;
  let below40 = 0;
  let below30 = 0;
  let above60 = 0;
  let suppressed = 0;
  let weighted = 0;
  let minIndex = Infinity;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const next = rows[i + 1];
    const raw = next ? next.atSeconds - r.atSeconds : 0;
    const dt = Math.min(Math.max(raw, 0), MAX_GAP_SECONDS) || 0;
    const span = i === rows.length - 1 && dt === 0 ? 0 : dt;
    seconds += span;
    weighted += r.index * span;
    if (r.index < minIndex) minIndex = r.index;
    if (r.index < 40) below40 += span;
    if (r.index < 30) below30 += span;
    if (r.index > 60) above60 += span;
    if ((r.suppressionRatio ?? 0) > 0) suppressed += span;
  }

  const minutes = seconds / 60;
  const meanIndex =
    seconds > 0
      ? weighted / seconds
      : rows.reduce((s, r) => s + r.index, 0) / rows.length;

  return {
    caseRef,
    readings: rows.length,
    minutes: round1(minutes),
    meanIndex: round1(meanIndex),
    minIndex: round1(minIndex),
    minutesBelow40: round1(below40 / 60),
    minutesBelow30: round1(below30 / 60),
    minutesAbove60: round1(above60 / 60),
    minutesSuppressed: round1(suppressed / 60),
    fractionBelow40: seconds > 0 ? below40 / seconds : 0,
    fractionBelow30: seconds > 0 ? below30 / seconds : 0,
    fractionSuppressed: seconds > 0 ? suppressed / seconds : 0,
  };
}

function round1(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

/* --------------------------------------------------------------- cohort --- */

export interface CohortCase {
  caseRef: string;
  exposure: DepthExposure;
  outcome: CaseOutcome | null;
}

export type OutcomeKey = "inHospitalDeath" | "icuStay" | "longStay";

export interface CohortContrast {
  key: OutcomeKey;
  label: string;
  /** Cases meeting the outcome. */
  withN: number;
  /** Cases with the outcome recorded but not met. */
  withoutN: number;
  /** Cases where the outcome is not recorded at all. */
  unknownN: number;
  withMinutesBelow40: number | null;
  withoutMinutesBelow40: number | null;
  withFractionBelow40: number | null;
  withoutFractionBelow40: number | null;
  withMinutesSuppressed: number | null;
  withoutMinutesSuppressed: number | null;
  /**
   * Whether either arm is too small for the contrast to mean anything. Shown
   * beside every number so a two-case difference is never read as a finding.
   */
  underpowered: boolean;
}

/** Minimum cases per arm before a contrast is worth reading at all. */
export const MIN_ARM = 10;

/** Hospital stay at or beyond this many days counts as a long stay. */
export const LONG_STAY_DAYS = 14;

function outcomeMet(outcome: CaseOutcome, key: OutcomeKey): boolean | null {
  if (key === "inHospitalDeath") return outcome.inHospitalDeath;
  if (key === "icuStay") return outcome.icuDays == null ? null : outcome.icuDays > 0;
  if (outcome.hospitalDays == null) return null;
  return outcome.hospitalDays >= LONG_STAY_DAYS;
}

const mean = (xs: number[]): number | null =>
  xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null;

export function cohortContrast(cases: CohortCase[], key: OutcomeKey, label: string): CohortContrast {
  const withArm: CohortCase[] = [];
  const withoutArm: CohortCase[] = [];
  let unknownN = 0;
  for (const c of cases) {
    const met = c.outcome ? outcomeMet(c.outcome, key) : null;
    if (met == null) unknownN++;
    else if (met) withArm.push(c);
    else withoutArm.push(c);
  }
  return {
    key,
    label,
    withN: withArm.length,
    withoutN: withoutArm.length,
    unknownN,
    withMinutesBelow40: mean(withArm.map((c) => c.exposure.minutesBelow40)),
    withoutMinutesBelow40: mean(withoutArm.map((c) => c.exposure.minutesBelow40)),
    withFractionBelow40: mean(withArm.map((c) => c.exposure.fractionBelow40)),
    withoutFractionBelow40: mean(withoutArm.map((c) => c.exposure.fractionBelow40)),
    withMinutesSuppressed: mean(withArm.map((c) => c.exposure.minutesSuppressed)),
    withoutMinutesSuppressed: mean(withoutArm.map((c) => c.exposure.minutesSuppressed)),
    underpowered: withArm.length < MIN_ARM || withoutArm.length < MIN_ARM,
  };
}

export function cohortContrasts(cases: CohortCase[]): CohortContrast[] {
  return [
    cohortContrast(cases, "inHospitalDeath", "Died in hospital"),
    cohortContrast(cases, "icuStay", "Needed intensive care"),
    cohortContrast(cases, `longStay`, `Stayed ${LONG_STAY_DAYS} days or more`),
  ];
}
