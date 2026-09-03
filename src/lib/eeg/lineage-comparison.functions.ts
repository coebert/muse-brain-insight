import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { LineageComparison } from "@/lib/eeg/lineage-comparison";

export interface LineageComparisonResult {
  lineages: LineageComparison[];
  /** Total paired readings seen, across every lineage. */
  totalPoints: number;
  generatedAt: string;
}

/**
 * Prediction-vs-reality for every acquisition lineage: each setup's paired
 * readings scored under its own live COEBIS model, never pooled together.
 */
export const getLineageComparison = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<LineageComparisonResult> => {
    const { loadTrainingMatrix } = await import("@/lib/eeg/coebis-training.server");
    const { modelFromRow } = await import("@/lib/eeg/coebis-refit.server");
    const { buildLineageComparisons, type LineageModel } = await import(
      "@/lib/eeg/lineage-comparison"
    );

    const matrix = await loadTrainingMatrix(context.supabase, 5000);

    const { data: versionRows } = await context.supabase
      .from("coebis_model_versions")
      .select("lineage_key, version, model_family, coefficients, is_active")
      .eq("is_active", true)
      .order("version", { ascending: false });

    const models = new Map<string, LineageModel>();
    for (const row of (versionRows ?? []) as unknown as Record<string, unknown>[]) {
      const key = String(row["lineage_key"]);
      if (models.has(key)) continue;
      const model = modelFromRow(row);
      if (model) models.set(key, { model, version: Number(row["version"]) });
    }

    // Which monitor each reading was paired against, for labelling only.
    const { data: deviceRows } = await context.supabase
      .from("bis_paired_points")
      .select("source_lineage, device, source")
      .limit(5000);
    const monitors = new Map<string, Set<string>>();
    for (const row of (deviceRows ?? []) as unknown as Record<string, unknown>[]) {
      const key = (row["source_lineage"] as string | null) ?? "unattributed";
      const label = (row["device"] as string | null) ?? (row["source"] as string | null);
      if (!label) continue;
      const set = monitors.get(key) ?? new Set<string>();
      set.add(label);
      monitors.set(key, set);
    }

    const lineages = buildLineageComparisons(matrix.points, models, (p) => {
      const set = monitors.get(p.lineageKey ?? "unattributed");
      return set && set.size === 1 ? [...set][0]! : null;
    }).map((l) => ({
      ...l,
      monitors: [...(monitors.get(l.lineageKey) ?? new Set<string>())].sort(),
    }));

    return {
      lineages,
      totalPoints: matrix.points.length,
      generatedAt: new Date().toISOString(),
    };
  });
