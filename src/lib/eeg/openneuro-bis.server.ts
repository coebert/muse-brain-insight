/** Server-only persistence for OpenNeuro-derived external BIS readings. */
import type { SupabaseClient } from "@supabase/supabase-js";

import { OPENNEURO_BIS_SOURCE, type OpenNeuroBisPoint } from "./openneuro-bis";
import type { VitalDbCovariates } from "./vitaldb";

type Client = SupabaseClient<any, any, any>;

export interface OpenNeuroBisCasePayload {
  caseRef: string;
  lineage: string;
  covariates: VitalDbCovariates;
  points: OpenNeuroBisPoint[];
}

export interface OpenNeuroBisImportResult {
  cases: number;
  inserted: number;
  skipped: number;
  lineages: string[];
}

export async function importOpenNeuroBisCases(
  supabase: Client,
  userId: string,
  cases: OpenNeuroBisCasePayload[],
): Promise<OpenNeuroBisImportResult> {
  const rows = cases.flatMap((c) =>
    c.points.map((p) => ({
      user_id: userId,
      source: OPENNEURO_BIS_SOURCE,
      source_lineage: c.lineage,
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
  if (!rows.length) return { cases: 0, inserted: 0, skipped: 0, lineages: [] };

  const refs = rows.map((r) => r.external_ref);
  const existing = new Set<string>();
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
    lineages: [...new Set(fresh.map((r) => r.source_lineage))],
  };
}

export interface OpenNeuroLineageRow {
  lineage: string;
  cases: number;
  readings: number;
  meanBis: number;
}

/** Per-dataset lineage summary, so each record's contribution stays visible. */
export async function loadOpenNeuroBisLineages(
  supabase: Client,
  limit = 20000,
): Promise<OpenNeuroLineageRow[]> {
  const { data, error } = await supabase
    .from("external_reference_points")
    .select("source_lineage, case_ref, bis")
    .eq("source", OPENNEURO_BIS_SOURCE)
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as {
    source_lineage: string;
    case_ref: string;
    bis: number;
  }[];
  const byLineage = new Map<string, { cases: Set<string>; sum: number; n: number }>();
  for (const r of rows) {
    const entry = byLineage.get(r.source_lineage) ?? { cases: new Set<string>(), sum: 0, n: 0 };
    entry.cases.add(r.case_ref);
    entry.sum += Number(r.bis);
    entry.n++;
    byLineage.set(r.source_lineage, entry);
  }
  return [...byLineage.entries()]
    .map(([lineage, e]) => ({
      lineage,
      cases: e.cases.size,
      readings: e.n,
      meanBis: Number((e.sum / Math.max(1, e.n)).toFixed(1)),
    }))
    .sort((a, b) => b.readings - a.readings);
}
