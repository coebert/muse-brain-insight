/** Server-only persistence for PhysioNet-derived spectral epochs. */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DSA_FREQ_START_HZ,
  DSA_FREQ_STEP_HZ,
  type PhysionetImportRow,
} from "./physionet";

type Client = SupabaseClient<any, any, any>;

export interface PhysionetImportResult {
  cases: number;
  inserted: number;
  skipped: number;
}

export interface PhysionetPoolSummary {
  total: number;
  byLineage: {
    lineage: string;
    epochs: number;
    cases: number;
    suppressedEpochs: number;
    /** Harmonisation versions present in this lineage, for auditing. */
    harmonizationVersions: string[];
    labels: { label: string; count: number }[];
  }[];
}

export async function importPhysionetEpochs(
  supabase: Client,
  userId: string,
  epochs: PhysionetImportRow[],
): Promise<PhysionetImportResult> {
  const rows = epochs.map((e) => ({
    user_id: userId,
    source: e.source,
    source_lineage: e.sourceLineage,
    dataset_version: e.datasetVersion,
    case_ref: e.caseRef,
    channel: e.channel,
    at_seconds: e.atSeconds,
    epoch_seconds: e.epochSeconds,
    sample_rate: e.sampleRate,
    freq_start_hz: DSA_FREQ_START_HZ,
    freq_step_hz: DSA_FREQ_STEP_HZ,
    spectrum_db: e.spectrumDb as unknown as never,
    bands: e.bands as unknown as never,
    total_power: e.totalPower,
    sef95: e.sef95,
    suppression_ratio: e.suppressionRatio,
    is_suppressed: e.isSuppressed,
    label: e.label,
    label_source: e.labelSource,
    covariates: e.covariates as unknown as never,
    harmonization: (e.harmonization ?? {}) as unknown as never,
    harmonized_montage: e.harmonization
      ? `${e.harmonization.target.derivation} (${e.harmonization.target.reference})`
      : null,
    harmonization_version: e.harmonization?.version ?? null,
    external_ref: e.externalRef,
  }));
  if (!rows.length) return { cases: 0, inserted: 0, skipped: 0 };

  const refs = rows.map((r) => r.external_ref);
  const existing = new Set<string>();
  for (let i = 0; i < refs.length; i += 500) {
    const { data } = await supabase
      .from("external_spectral_epochs")
      .select("external_ref")
      .in("external_ref", refs.slice(i, i + 500));
    for (const r of (data ?? []) as unknown as { external_ref: string }[]) {
      existing.add(r.external_ref);
    }
  }

  const fresh = rows.filter((r) => !existing.has(r.external_ref));
  for (let i = 0; i < fresh.length; i += 500) {
    const { error } = await supabase
      .from("external_spectral_epochs")
      .insert(fresh.slice(i, i + 500) as never);
    if (error) throw new Error(error.message);
  }

  return {
    cases: new Set(fresh.map((r) => r.case_ref)).size,
    inserted: fresh.length,
    skipped: rows.length - fresh.length,
  };
}

export async function loadPhysionetPool(
  supabase: Client,
  limit = 20000,
): Promise<PhysionetPoolSummary> {
  const { data, error } = await supabase
    .from("external_spectral_epochs")
    .select("source_lineage, case_ref, label, is_suppressed, harmonization_version")
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as {
    source_lineage: string;
    case_ref: string;
    label: string | null;
    is_suppressed: boolean;
    harmonization_version: string | null;
  }[];

  const groups = new Map<
    string,
    {
      epochs: number;
      cases: Set<string>;
      suppressed: number;
      labels: Map<string, number>;
      versions: Set<string>;
    }
  >();
  for (const r of rows) {
    let g = groups.get(r.source_lineage);
    if (!g) {
      g = {
        epochs: 0,
        cases: new Set(),
        suppressed: 0,
        labels: new Map(),
        versions: new Set(),
      };
      groups.set(r.source_lineage, g);
    }
    g.epochs++;
    g.cases.add(r.case_ref);
    if (r.is_suppressed) g.suppressed++;
    if (r.label) g.labels.set(r.label, (g.labels.get(r.label) ?? 0) + 1);
    if (r.harmonization_version) g.versions.add(r.harmonization_version);
  }

  return {
    total: rows.length,
    byLineage: [...groups.entries()]
      .map(([lineage, g]) => ({
        lineage,
        epochs: g.epochs,
        cases: g.cases.size,
        suppressedEpochs: g.suppressed,
        harmonizationVersions: [...g.versions].sort(),
        labels: [...g.labels.entries()]
          .map(([label, count]) => ({ label, count }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.epochs - a.epochs),
  };
}
