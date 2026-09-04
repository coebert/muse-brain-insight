/** Server-only persistence for ds004541 event-referenced depth readings. */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  OPENNEURO_DEPTH_DEVICE_ID,
  OPENNEURO_DEPTH_REFERENCE_KIND,
  type EventDepthPoint,
} from "./openneuro-depth";
import { OPENNEURO_DS004541_SOURCE } from "./openneuro";

type Client = SupabaseClient<any, any, any>;

export interface EventDepthCase {
  caseRef: string;
  lineageKey: string;
  channel: string;
  covariates: {
    ageBand: string | null;
    sex: string | null;
    regimen: string | null;
  };
  points: EventDepthPoint[];
}

/**
 * Where the readings came from. Defaults describe ds004541; another
 * event-referenced source passes its own device, source and reference kind so
 * the two never share a lineage or masquerade as each other.
 */
export interface EventDepthProvenance {
  device?: string;
  source?: string;
  sourceSite?: string;
  referenceKind?: string;
  /** Extra per-reading provenance, e.g. the clinical score behind a reference. */
  pointFeatures?: (point: EventDepthPoint) => Record<string, unknown>;
}

export interface EventDepthImportResult {
  cases: number;
  inserted: number;
  skipped: number;
  lineages: string[];
}

/**
 * Store event-referenced readings as paired points. They are explicitly marked
 * as an event-state reference, not a monitor reading, and carry their own
 * acquisition lineage so no device-specific fit can absorb them.
 */
export async function importEventDepthCases(
  supabase: Client,
  userId: string,
  cases: EventDepthCase[],
  provenance: EventDepthProvenance = {},
): Promise<EventDepthImportResult> {
  const device = provenance.device ?? OPENNEURO_DEPTH_DEVICE_ID;
  const source = provenance.source ?? OPENNEURO_DS004541_SOURCE;
  const sourceSite = provenance.sourceSite ?? "openneuro";
  const referenceKind = provenance.referenceKind ?? OPENNEURO_DEPTH_REFERENCE_KIND;
  const rows = cases.flatMap((c) =>
    c.points.map((p) => ({
      user_id: userId,
      session_id: null,
      at_seconds: p.atSeconds,
      bis: p.reference,
      bis_sef: null,
      bis_sr: null,
      app_index: p.appIndex,
      app_sef: p.appSef,
      app_sr: p.appSr,
      reliable: p.reliable,
      sqi: null,
      lag_seconds: 0,
      context: "general",
      device,
      source,
      source_site: sourceSite,
      source_lineage: c.lineageKey,
      feature_source: "replay",
      external_ref: p.externalRef,
      features: {
        imported: true,
        replayed: true,
        referenceKind,
        referenceSigma: p.referenceSigma,
        state: p.state,
        channel: c.channel,
        caseRef: c.caseRef,
        ageBand: c.covariates.ageBand,
        sex: c.covariates.sex,
        regimen: c.covariates.regimen,
        ...(provenance.pointFeatures?.(p) ?? {}),
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
