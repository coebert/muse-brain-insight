/**
 * Server-only loaders for external validation. External rows are read
 * per lineage and handed to the pure benchmark functions; nothing here ever
 * writes external data back into the training pool.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HarmonizationRecord } from "./harmonization";
import type { ReferenceOnlyPoint, SpectralLabelPoint } from "./external-validation";

type Client = SupabaseClient<any, any, any>;

export interface ReferenceLineageGroup {
  lineage: string;
  points: ReferenceOnlyPoint[];
}

export interface SpectralLineageGroup {
  lineage: string;
  points: SpectralLabelPoint[];
  harmonization: HarmonizationRecord | null;
}

/** Monitor readings with covariates but no app index (e.g. VitalDB). */
export async function loadReferenceLineages(
  supabase: Client,
  limit = 20000,
): Promise<ReferenceLineageGroup[]> {
  const { data, error } = await supabase
    .from("external_reference_points")
    .select("source_lineage, case_ref, bis, ce, age_band, sex, regimen, frailty")
    .limit(limit);
  if (error) throw new Error(error.message);

  const groups = new Map<string, ReferenceOnlyPoint[]>();
  for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
    const lineage = String(r["source_lineage"] ?? "external:unknown");
    const bis = Number(r["bis"]);
    if (!Number.isFinite(bis)) continue;
    const list = groups.get(lineage) ?? [];
    list.push({
      caseRef: String(r["case_ref"] ?? "?"),
      bis,
      cov: {
        ageBand: (r["age_band"] as string | null) ?? null,
        sex: (r["sex"] as string | null) ?? null,
        regimen: (r["regimen"] as string | null) ?? null,
        frailty: (r["frailty"] as string | null) ?? null,
      },
      ce: (r["ce"] as Record<string, number> | null) ?? null,
    });
    groups.set(lineage, list);
  }
  return [...groups].map(([lineage, points]) => ({ lineage, points }));
}

/** Labelled DSA epochs (e.g. PhysioNet), grouped by lineage. */
export async function loadSpectralLineages(
  supabase: Client,
  limit = 50000,
): Promise<SpectralLineageGroup[]> {
  const { data, error } = await supabase
    .from("external_spectral_epochs")
    .select(
      "source_lineage, case_ref, label, label_source, suppression_ratio, is_suppressed, sef95, harmonization",
    )
    .limit(limit);
  if (error) throw new Error(error.message);

  const groups = new Map<string, SpectralLineageGroup>();
  for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
    const lineage = String(r["source_lineage"] ?? "external:unknown");
    const g =
      groups.get(lineage) ??
      ({ lineage, points: [], harmonization: null } satisfies SpectralLineageGroup);
    const h = r["harmonization"] as HarmonizationRecord | null;
    if (!g.harmonization && h && typeof h === "object" && "version" in h) g.harmonization = h;
    g.points.push({
      caseRef: String(r["case_ref"] ?? "?"),
      label: (r["label"] as string | null) ?? null,
      labelSource: r["label_source"] === "dataset" ? "dataset" : "derived",
      suppressionRatio: Number(r["suppression_ratio"] ?? 0),
      isSuppressed: Boolean(r["is_suppressed"]),
      sef95: Number(r["sef95"] ?? Number.NaN),
    });
    groups.set(lineage, g);
  }
  return [...groups.values()];
}
