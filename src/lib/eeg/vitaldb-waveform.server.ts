/** Server-only persistence for VitalDB waveform-derived paired readings. */
import type { SupabaseClient } from "@supabase/supabase-js";

import { VITALDB_SOURCE, type VitalDbCovariates } from "./vitaldb";
import type { VitalDbPairedPoint } from "./vitaldb-waveform";

type Client = SupabaseClient<any, any, any>;

export interface VitalDbPairedPayload {
  caseRef: string;
  lineageKey: string;
  covariates: VitalDbCovariates;
  points: VitalDbPairedPoint[];
}

export interface VitalDbPairedImportResult {
  cases: number;
  inserted: number;
  skipped: number;
  lineages: string[];
}

export async function importVitalDbPairedCases(
  supabase: Client,
  userId: string,
  cases: VitalDbPairedPayload[],
): Promise<VitalDbPairedImportResult> {
  const rows = cases.flatMap((c) =>
    c.points.map((p) => ({
      user_id: userId,
      session_id: null,
      at_seconds: p.atSeconds,
      bis: p.bis,
      bis_sef: p.bisSef,
      bis_sr: p.bisSr,
      app_index: p.appIndex,
      app_sef: p.appSef,
      app_sr: p.appSr,
      reliable: p.reliable,
      sqi: p.sqi,
      lag_seconds: p.lagSeconds,
      context: "general",
      device: "vitaldb-snuadc",
      source: VITALDB_SOURCE,
      source_site: "vitaldb",
      source_lineage: c.lineageKey,
      feature_source: "replay",
      ce: p.ce as unknown as never,
      external_ref: p.externalRef,
      // Covariates travel on the row: an imported reading has no local case to
      // join to, and the refit reads them from here.
      features: {
        imported: true,
        replayed: true,
        caseRef: c.caseRef,
        ageBand: c.covariates.ageBand,
        sex: c.covariates.sex,
        regimen: c.covariates.regimen,
        frailty: c.covariates.frailty,
      } as unknown as never,
    })),
  );
  if (!rows.length) return { cases: 0, inserted: 0, skipped: 0, lineages: [] };

  const refs = rows.map((r) => r.external_ref);
  const existing = new Set<string>();
  for (let i = 0; i < refs.length; i += 500) {
    const { data } = await supabase
      .from("bis_paired_points")
      .select("external_ref")
      .in("external_ref", refs.slice(i, i + 500));
    for (const r of (data ?? []) as unknown as { external_ref: string | null }[]) {
      if (r.external_ref) existing.add(r.external_ref);
    }
  }

  const fresh = rows.filter((r) => !existing.has(r.external_ref));
  for (let i = 0; i < fresh.length; i += 500) {
    const { error } = await supabase
      .from("bis_paired_points")
      .insert(fresh.slice(i, i + 500) as never);
    if (error) throw new Error(error.message);
  }

  return {
    cases: new Set(
      fresh.map((r) => (r.features as unknown as { caseRef: string }).caseRef),
    ).size,
    inserted: fresh.length,
    skipped: rows.length - fresh.length,
    lineages: [...new Set(fresh.map((r) => r.source_lineage))],
  };
}

export interface PairedLineageRow {
  lineageKey: string;
  cases: number;
  readings: number;
}

/** Paired readings per acquisition lineage — what the refit gate counts. */
export async function loadPairedLineageCounts(
  supabase: Client,
  limit = 20000,
): Promise<PairedLineageRow[]> {
  const { data, error } = await supabase
    .from("bis_paired_points")
    .select("source_lineage, features, session_id")
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as {
    source_lineage: string | null;
    features: { caseRef?: string } | null;
    session_id: string | null;
  }[];
  const by = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.source_lineage ?? "unlabelled";
    const caseId = r.features?.caseRef ?? r.session_id ?? "unknown";
    const set = by.get(key) ?? new Set<string>();
    set.add(caseId);
    by.set(key, set);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([lineageKey, readings]) => ({
      lineageKey,
      readings,
      cases: by.get(lineageKey)?.size ?? 0,
    }))
    .sort((a, b) => b.readings - a.readings);
}
