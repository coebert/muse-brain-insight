import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { fitCoebisModel } from "@/lib/eeg/coebis-covariates";
import { loadTrainingMatrix } from "@/lib/eeg/coebis-training.server";
import {
  benchmarkReferenceOnly,
  benchmarkSpectralLabels,
  buildExternalValidationReport,
  type ExternalValidationReport,
  type LineageBenchmark,
} from "@/lib/eeg/external-validation";
import {
  loadReferenceLineages,
  loadSpectralLineages,
} from "@/lib/eeg/external-validation.server";

/**
 * Fit COEBIS on the user's own paired readings only, then score that model
 * separately on every imported external lineage. External data is a held-out
 * benchmark here, never training input, and results are reported per lineage.
 */
export const getExternalValidation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ExternalValidationReport> => {
    const { supabase } = context;
    const matrix = await loadTrainingMatrix(supabase);
    const model = matrix.points.length ? fitCoebisModel(matrix.points, "covariate") : null;

    const lineages: LineageBenchmark[] = [];

    if (model) {
      for (const group of await loadReferenceLineages(supabase)) {
        lineages.push(benchmarkReferenceOnly(model, group.lineage, group.points));
      }
    }
    for (const group of await loadSpectralLineages(supabase)) {
      lineages.push(
        benchmarkSpectralLabels(group.lineage, group.points, group.harmonization),
      );
    }

    return buildExternalValidationReport(
      { n: matrix.points.length, cases: matrix.cases, family: model?.family ?? null },
      lineages,
    );
  });
