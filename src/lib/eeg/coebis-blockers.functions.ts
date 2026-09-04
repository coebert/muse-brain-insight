import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CovariateOpportunity, LineageBlocker } from "@/lib/eeg/coebis-blockers";

export interface LineageCovariates {
  lineageKey: string;
  readings: number;
  covariates: CovariateOpportunity[];
}

export interface BlockerReport {
  lineages: LineageBlocker[];
  perLineageCovariates: LineageCovariates[];
  pooledCovariates: CovariateOpportunity[];
  gate: { minPoints: number; minCases: number; stableCases: number };
  validatedPoints: number;
  rejected: Record<string, number>;
  generatedAt: string;
}

/** Gate status per acquisition lineage plus covariate headroom for COEBIS. */
export const getCoebisBlockers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BlockerReport> => {
    const { loadTrainingMatrix } = await import("@/lib/eeg/coebis-training.server");
    const {
      buildLineageBlockers,
      covariateOpportunities,
      STABLE_CV_CASES,
    } = await import("@/lib/eeg/coebis-blockers");
    const { selectValidatedPoints } = await import("@/lib/eeg/coebis-refit");
    const { MIN_POINTS, MIN_SESSIONS } = await import("@/lib/eeg/bis-drift");

    const matrix = await loadTrainingMatrix(context.supabase, 60000, undefined, 20000);
    const validated = selectValidatedPoints(matrix.points);

    const { data: versionRows } = await context.supabase
      .from("coebis_model_versions")
      .select("lineage_key, version, promoted, is_active, mae_gain, created_at")
      .order("version", { ascending: false });

    const versions = ((versionRows ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      lineageKey: String(r["lineage_key"]),
      version: Number(r["version"]),
      promoted: Boolean(r["promoted"]),
      isActive: Boolean(r["is_active"]),
      maeGain: r["mae_gain"] == null ? null : Number(r["mae_gain"]),
      createdAt: (r["created_at"] as string | null) ?? null,
    }));

    const lineages = buildLineageBlockers(validated.used, versions);
    const perLineageCovariates = lineages
      .filter((l) => l.readings > 0)
      .map((l) => {
        const subset = validated.used.filter((p) => (p.lineageKey ?? "unattributed") === l.lineageKey);
        return {
          lineageKey: l.lineageKey,
          readings: subset.length,
          covariates: covariateOpportunities(subset),
        };
      });

    return {
      lineages,
      perLineageCovariates,
      pooledCovariates: covariateOpportunities(validated.used),
      gate: { minPoints: MIN_POINTS, minCases: MIN_SESSIONS, stableCases: STABLE_CV_CASES },
      validatedPoints: validated.used.length,
      rejected: validated.rejected,
      generatedAt: new Date().toISOString(),
    };
  });
