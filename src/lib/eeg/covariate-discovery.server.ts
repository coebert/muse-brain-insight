/**
 * Server-only loader for covariate–feature discovery.
 *
 * Pulls stored spectral epochs from every ingested lineage (external datasets
 * plus the app's own recorded cases) and reduces them to the row shape the pure
 * discovery module expects. Epochs are sampled with a stride so a single very
 * long recording cannot dominate the pass.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildAdoptionLedger, type DiscoveryBundle } from "./discovery-adoption";
import { fitDiagnosisModels } from "./diagnosis-model";
import {
  discoverCovariateFeatures,
  featuresFromBands,
  type DiscoveryResult,
  type DiscoveryRow,
} from "./covariate-discovery";

type Client = SupabaseClient<any, any, any>;

/** Rows fetched per page from the external epoch table. */
const PAGE = 1000;
/** Epochs kept per case, after which further epochs are sampled out. */
const MAX_EPOCHS_PER_CASE = 400;

interface ExternalRow {
  source_lineage: string;
  case_ref: string;
  bands: Record<string, unknown> | null;
  total_power: number | null;
  sef95: number | null;
  suppression_ratio: number | null;
  covariates: Record<string, string | number | null> | null;
}

interface AppEpochRow {
  session_id: string;
  bands: Record<string, unknown> | null;
  total_power: number | null;
  spectral_edge_95: number | null;
  suppression_ratio: number | null;
}

interface SessionRow {
  id: string;
  device_name: string | null;
  age_band: string | null;
  sex: string | null;
  regimen: string | null;
  chronic_burden: string | null;
  acute_class: string | null;
  context: string | null;
}

function keep(counts: Map<string, number>, caseRef: string): boolean {
  const seen = counts.get(caseRef) ?? 0;
  counts.set(caseRef, seen + 1);
  // Keep the first N epochs of a case in full, then thin progressively.
  if (seen < MAX_EPOCHS_PER_CASE) return true;
  return seen % 10 === 0;
}

async function loadExternalRows(supabase: Client, limit: number): Promise<DiscoveryRow[]> {
  const rows: DiscoveryRow[] = [];
  const counts = new Map<string, number>();
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("external_spectral_epochs")
      .select("source_lineage, case_ref, bands, total_power, sef95, suppression_ratio, covariates")
      .order("created_at", { ascending: true })
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as ExternalRow[];
    for (const r of page) {
      const caseRef = `${r.source_lineage}/${r.case_ref}`;
      if (!keep(counts, caseRef)) continue;
      const features = featuresFromBands(r.bands, r.total_power, r.sef95, r.suppression_ratio);
      if (!features) continue;
      rows.push({
        lineage: r.source_lineage,
        caseRef,
        covariates: r.covariates ?? {},
        features,
      });
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

async function loadAppRows(supabase: Client, limit: number): Promise<DiscoveryRow[]> {
  const { data: sessionData, error: sessionError } = await supabase
    .from("eeg_sessions")
    .select("id, device_name, age_band, sex, regimen, chronic_burden, acute_class, context")
    .order("started_at", { ascending: false })
    .limit(200);
  if (sessionError) throw new Error(sessionError.message);
  const sessions = (sessionData ?? []) as unknown as SessionRow[];
  if (!sessions.length) return [];
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const { data, error } = await supabase
    .from("eeg_epochs")
    .select("session_id, bands, total_power, spectral_edge_95, suppression_ratio")
    .in("session_id", [...byId.keys()])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const counts = new Map<string, number>();
  const rows: DiscoveryRow[] = [];
  for (const r of (data ?? []) as unknown as AppEpochRow[]) {
    const session = byId.get(r.session_id);
    if (!session) continue;
    const caseRef = `app/${r.session_id}`;
    if (!keep(counts, caseRef)) continue;
    const features = featuresFromBands(
      r.bands,
      r.total_power,
      r.spectral_edge_95,
      r.suppression_ratio,
    );
    if (!features) continue;
    rows.push({
      // Device-specific lineage: an app fit must never be pooled across devices.
      lineage: `app:${(session.device_name ?? "unknown").toLowerCase().replace(/\s+/g, "-")}`,
      caseRef,
      covariates: {
        age_band: session.age_band,
        sex: session.sex,
        regimen: session.regimen,
        chronic_burden: session.chronic_burden,
        acute_class: session.acute_class,
        setting: session.context,
      },
      features,
    });
  }
  return rows;
}

/** Run the discovery pass across external lineages and the app's own cases. */
export async function runCovariateDiscovery(
  supabase: Client,
  options: { externalLimit?: number; appLimit?: number } = {},
): Promise<DiscoveryBundle> {
  const [external, app] = await Promise.all([
    loadExternalRows(supabase, options.externalLimit ?? 12000),
    loadAppRows(supabase, options.appLimit ?? 6000),
  ]);
  const rows = [...external, ...app];
  const result: DiscoveryResult = discoverCovariateFeatures(rows);
  return {
    ...result,
    adoption: buildAdoptionLedger(result),
    diagnosis: fitDiagnosisModels(rows),
  };
}
