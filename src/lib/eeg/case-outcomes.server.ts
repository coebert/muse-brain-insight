/**
 * Server-side assembly of the outcome cohort: confirmed clinical outcomes from
 * the source registry, joined to time-weighted depth exposure computed in the
 * database so a long case never has to be pulled row by row into the app.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  cohortContrasts,
  parseVitalDbOutcomeCsv,
  type CaseOutcome,
  type CohortCase,
  type CohortContrast,
  type DepthExposure,
} from "@/lib/eeg/case-outcomes";

type Client = SupabaseClient<Database>;

export const VITALDB_LINEAGE = "external:vitaldb";
export const VITALDB_CLINICAL_URL = "https://api.vitaldb.net/cases";

/* ------------------------------------------------------------- download --- */

/** The registry serves the clinical table gzipped; decompress when it is. */
async function readMaybeGzip(response: Response): Promise<string> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  const gzipped = buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (!gzipped) return new TextDecoder().decode(buffer);
  const stream = new Blob([buffer as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export async function fetchVitalDbOutcomes(): Promise<Map<string, CaseOutcome>> {
  const response = await fetch(VITALDB_CLINICAL_URL);
  if (!response.ok) {
    throw new Error(`The clinical table could not be downloaded (${response.status}).`);
  }
  return parseVitalDbOutcomeCsv(await readMaybeGzip(response));
}

/* --------------------------------------------------------------- import --- */

export interface OutcomeImportResult {
  casesInPool: number;
  matched: number;
  stored: number;
  missing: string[];
  withDeath: number;
  withIcu: number;
  withStay: number;
}

/** Case refs that already have paired depth readings in the pool. */
async function pooledCaseRefs(supabase: Client, lineage: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("external_depth_exposure", {
    _lineage: lineage,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.case_ref);
}

/**
 * Pull the registry's clinical table and store outcomes for every case we
 * already hold EEG readings for. Cases without readings are ignored: the point
 * is a paired dataset, not a copy of someone else's registry.
 */
export async function importVitalDbOutcomes(
  supabase: Client,
  userId: string,
): Promise<OutcomeImportResult> {
  const refs = await pooledCaseRefs(supabase, VITALDB_LINEAGE);
  const outcomes = await fetchVitalDbOutcomes();
  const byRef = new Map<string, CaseOutcome>();
  for (const outcome of outcomes.values()) byRef.set(outcome.caseRef, outcome);

  const rows: Database["public"]["Tables"]["external_case_outcomes"]["Insert"][] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const outcome = byRef.get(ref);
    if (!outcome) {
      missing.push(ref);
      continue;
    }
    rows.push({
      user_id: userId,
      source: "vitaldb",
      source_lineage: VITALDB_LINEAGE,
      case_ref: ref,
      in_hospital_death: outcome.inHospitalDeath,
      icu_days: outcome.icuDays,
      hospital_days: outcome.hospitalDays,
      emergency: outcome.emergency,
      asa: outcome.asa,
      age_years: outcome.ageYears,
      sex: outcome.sex,
      department: outcome.department,
      optype: outcome.optype,
      approach: outcome.approach,
      comorbidities: outcome.comorbidities,
      raw: {},
    });
  }

  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase
      .from("external_case_outcomes")
      .upsert(rows.slice(i, i + 100), { onConflict: "user_id,source_lineage,case_ref" });
    if (error) throw new Error(error.message);
  }

  return {
    casesInPool: refs.length,
    matched: rows.length,
    stored: rows.length,
    missing: missing.slice(0, 20),
    withDeath: rows.filter((r) => r.in_hospital_death != null).length,
    withIcu: rows.filter((r) => r.icu_days != null).length,
    withStay: rows.filter((r) => r.hospital_days != null).length,
  };
}

/* --------------------------------------------------------------- cohort --- */

export interface CohortReport {
  lineage: string;
  cases: CohortCase[];
  casesWithOutcome: number;
  contrasts: CohortContrast[];
}

function exposureFromRow(row: {
  case_ref: string;
  readings: number;
  seconds: number;
  mean_index: number | null;
  min_index: number | null;
  seconds_below_40: number | null;
  seconds_below_30: number | null;
  seconds_above_60: number | null;
  seconds_suppressed: number | null;
}): DepthExposure {
  const seconds = Number(row.seconds ?? 0);
  const min = (v: number | null) => Math.round((Number(v ?? 0) / 60) * 10) / 10;
  const share = (v: number | null) => (seconds > 0 ? Number(v ?? 0) / seconds : 0);
  return {
    caseRef: row.case_ref,
    readings: Number(row.readings ?? 0),
    minutes: Math.round((seconds / 60) * 10) / 10,
    meanIndex: Math.round(Number(row.mean_index ?? 0) * 10) / 10,
    minIndex: Math.round(Number(row.min_index ?? 0) * 10) / 10,
    minutesBelow40: min(row.seconds_below_40),
    minutesBelow30: min(row.seconds_below_30),
    minutesAbove60: min(row.seconds_above_60),
    minutesSuppressed: min(row.seconds_suppressed),
    fractionBelow40: share(row.seconds_below_40),
    fractionBelow30: share(row.seconds_below_30),
    fractionSuppressed: share(row.seconds_suppressed),
  };
}

export async function loadCohort(
  supabase: Client,
  lineage = VITALDB_LINEAGE,
): Promise<CohortReport> {
  const [{ data: exposure, error: exposureError }, { data: outcomes, error: outcomeError }] =
    await Promise.all([
      supabase.rpc("external_depth_exposure", { _lineage: lineage }),
      supabase
        .from("external_case_outcomes")
        .select(
          "case_ref, in_hospital_death, icu_days, hospital_days, emergency, asa, age_years, sex, department, optype, approach, comorbidities",
        )
        .eq("source_lineage", lineage)
        .limit(1000),
    ]);
  if (exposureError) throw new Error(exposureError.message);
  if (outcomeError) throw new Error(outcomeError.message);

  const byRef = new Map<string, CaseOutcome>();
  for (const row of outcomes ?? []) {
    byRef.set(row.case_ref, {
      caseRef: row.case_ref,
      inHospitalDeath: row.in_hospital_death,
      icuDays: row.icu_days == null ? null : Number(row.icu_days),
      hospitalDays: row.hospital_days == null ? null : Number(row.hospital_days),
      emergency: row.emergency,
      asa: row.asa,
      ageYears: row.age_years,
      sex: row.sex,
      department: row.department,
      optype: row.optype,
      approach: row.approach,
      comorbidities: row.comorbidities ?? [],
    });
  }

  const cases: CohortCase[] = (exposure ?? [])
    .map((row) => ({
      caseRef: row.case_ref,
      exposure: exposureFromRow(row),
      outcome: byRef.get(row.case_ref) ?? null,
    }))
    .sort((a, b) => b.exposure.minutesBelow40 - a.exposure.minutesBelow40);

  return {
    lineage,
    cases,
    casesWithOutcome: cases.filter((c) => c.outcome != null).length,
    contrasts: cohortContrasts(cases),
  };
}
