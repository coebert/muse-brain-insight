/**
 * Server-side assembly of the blocked-lineage report.
 *
 * Extracted from the server function so the cached analysis pass and the
 * on-demand call share one implementation.
 */
import type { CovariateOpportunity, LineageBlocker } from "@/lib/eeg/coebis-blockers";

type Client = Parameters<typeof import("@/lib/eeg/coebis-training.server").loadTrainingMatrix>[0];

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

export async function loadBlockerReport(supabase: Client): Promise<BlockerReport> {
  const { loadTrainingMatrix } = await import("@/lib/eeg/coebis-training.server");
  const { buildLineageBlockers, covariateOpportunities, STABLE_CV_CASES } = await import(
    "@/lib/eeg/coebis-blockers"
  );
  const { selectValidatedPoints } = await import("@/lib/eeg/coebis-refit");
  const { MIN_POINTS, MIN_SESSIONS } = await import("@/lib/eeg/bis-drift");

  const matrix = await loadTrainingMatrix(supabase, 200000, undefined, 60000);
  const validated = selectValidatedPoints(matrix.points);

  const { data: versionRows } = await supabase
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
      const subset = validated.used.filter(
        (p) => (p.lineageKey ?? "unattributed") === l.lineageKey,
      );
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
}
