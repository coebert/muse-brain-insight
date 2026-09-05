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

/**
 * Rows fetched per statement. One 50k-row statement over these tables runs past
 * the database's own time limit and is cancelled, which left the analysis pages
 * empty; smaller indexed pages return the same rows well inside it.
 */
const PAGE = 2000;

/** Read a table in indexed pages, stopping at the first short page. */
async function pageRows(
  query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1;
    const { data, error } = await query(from, to);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < to - from + 1) break;
  }
  return out;
}

/** Monitor readings with covariates but no app index (e.g. VitalDB). */
export async function loadReferenceLineages(
  supabase: Client,
  limit = 20000,
): Promise<ReferenceLineageGroup[]> {
  const rows = await pageRows(
    (from, to) =>
      supabase
        .from("external_reference_points")
        .select("source_lineage, case_ref, bis, ce, age_band, sex, regimen, frailty")
        .order("case_ref", { ascending: true })
        .range(from, to),
    limit,
  );

  const groups = new Map<string, ReferenceOnlyPoint[]>();
  for (const r of rows) {
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
  const rows = await pageRows(
    (from, to) =>
      supabase
        .from("external_spectral_epochs")
        .select(
          "source_lineage, case_ref, label, label_source, suppression_ratio, is_suppressed, sef95, harmonization",
        )
        .order("source_lineage", { ascending: true })
        .order("case_ref", { ascending: true })
        .range(from, to),
    limit,
  );

  const groups = new Map<string, SpectralLineageGroup>();
  for (const r of rows) {
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
