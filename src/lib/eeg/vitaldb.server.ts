/** Server-only persistence for VitalDB-derived external reference readings. */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  summariseExternalPriors,
  VITALDB_LINEAGE,
  VITALDB_SOURCE,
  type ExternalPriorSummary,
  type VitalDbCovariates,
  type VitalDbPoint,
} from "./vitaldb";

type Client = SupabaseClient<any, any, any>;

export interface VitalDbCasePayload {
  caseRef: string;
  covariates: VitalDbCovariates;
  points: VitalDbPoint[];
}

export interface VitalDbImportResult {
  cases: number;
  inserted: number;
  skipped: number;
}

export async function importVitalDbCases(
  supabase: Client,
  userId: string,
  cases: VitalDbCasePayload[],
): Promise<VitalDbImportResult> {
  const rows = cases.flatMap((c) =>
    c.points.map((p) => ({
      user_id: userId,
      source: VITALDB_SOURCE,
      source_lineage: VITALDB_LINEAGE,
      case_ref: c.caseRef,
      at_seconds: p.atSeconds,
      bis: p.bis,
      bis_sef: p.bisSef,
      bis_sr: p.bisSr,
      bis_emg: p.bisEmg,
      sqi: p.sqi,
      ce: p.ce as unknown as never,
      age_band: c.covariates.ageBand,
      sex: c.covariates.sex,
      regimen: c.covariates.regimen,
      frailty: c.covariates.frailty,
      asa: c.covariates.asa,
      external_ref: p.externalRef,
    })),
  );
  if (!rows.length) return { cases: 0, inserted: 0, skipped: 0 };

  const refs = rows.map((r) => r.external_ref);
  const existing = new Set<string>();
  // Chunked so a large multi-case import does not build one enormous filter.
  for (let i = 0; i < refs.length; i += 500) {
    const { data } = await supabase
      .from("external_reference_points")
      .select("external_ref")
      .in("external_ref", refs.slice(i, i + 500));
    for (const r of (data ?? []) as unknown as { external_ref: string }[]) {
      existing.add(r.external_ref);
    }
  }

  const fresh = rows.filter((r) => !existing.has(r.external_ref));
  for (let i = 0; i < fresh.length; i += 500) {
    const { error } = await supabase
      .from("external_reference_points")
      .insert(fresh.slice(i, i + 500) as never);
    if (error) throw new Error(error.message);
  }

  return {
    cases: new Set(fresh.map((r) => r.case_ref)).size,
    inserted: fresh.length,
    skipped: rows.length - fresh.length,
  };
}

export async function loadExternalPriors(
  supabase: Client,
  limit = 20000,
): Promise<ExternalPriorSummary> {
  const { data, error } = await supabase
    .from("external_reference_points")
    .select("case_ref, bis, ce, age_band, sex, regimen, frailty")
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return summariseExternalPriors(
    rows.map((r) => ({
      caseRef: String(r["case_ref"]),
      bis: Number(r["bis"]),
      ce: (r["ce"] as Record<string, number> | null) ?? null,
      ageBand: (r["age_band"] as string | null) ?? null,
      sex: (r["sex"] as string | null) ?? null,
      regimen: (r["regimen"] as string | null) ?? null,
      frailty: (r["frailty"] as string | null) ?? null,
    })),
  );
}
