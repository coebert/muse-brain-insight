/** Server-only persistence for figshare 5589841 paired readings. */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  FIGSHARE_BIS_DEVICE_ID,
  FIGSHARE_BIS_SOURCE,
  type FigshareBisPoint,
} from "./figshare-bis";

type Client = SupabaseClient<any, any, any>;

export interface FigshareBisPayload {
  caseRef: string;
  lineageKey: string;
  points: FigshareBisPoint[];
}

export interface FigshareBisImportResult {
  cases: number;
  inserted: number;
  skipped: number;
  lineages: string[];
}

/**
 * Store replayed pairs. The record publishes no demographics, drug regimen or
 * ASA grade, so no covariate is written — an absent covariate must read as
 * absent to the refit, not as an invented level.
 */
export async function importFigshareBisCases(
  supabase: Client,
  userId: string,
  cases: FigshareBisPayload[],
): Promise<FigshareBisImportResult> {
  const rows = cases.flatMap((c) =>
    c.points.map((p) => ({
      user_id: userId,
      session_id: null,
      at_seconds: p.atSeconds,
      bis: p.bis,
      bis_sef: null,
      bis_sr: null,
      app_index: p.appIndex,
      app_sef: p.appSef,
      app_sr: p.appSr,
      reliable: p.reliable,
      sqi: null,
      lag_seconds: p.lagSeconds,
      context: "general",
      device: FIGSHARE_BIS_DEVICE_ID,
      source: FIGSHARE_BIS_SOURCE,
      source_site: "figshare",
      source_lineage: c.lineageKey,
      feature_source: "replay",
      external_ref: p.externalRef,
      features: {
        imported: true,
        replayed: true,
        caseRef: c.caseRef,
        licence: "CC BY 4.0",
        ageBand: null,
        sex: null,
        regimen: null,
        frailty: null,
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
    cases: new Set(fresh.map((r) => (r.features as unknown as { caseRef: string }).caseRef)).size,
    inserted: fresh.length,
    skipped: rows.length - fresh.length,
    lineages: [...new Set(fresh.map((r) => r.source_lineage))],
  };
}
