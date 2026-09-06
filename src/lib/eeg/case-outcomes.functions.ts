import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CohortReport, OutcomeImportResult } from "@/lib/eeg/case-outcomes.server";

/** The paired cohort: depth exposure per case beside its confirmed outcome. */
export const getOutcomeCohort = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CohortReport> => {
    const { loadCohort } = await import("@/lib/eeg/case-outcomes.server");
    return loadCohort(context.supabase);
  });

/** Pull the registry's clinical table and attach outcomes to pooled cases. */
export const importCohortOutcomes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OutcomeImportResult> => {
    const { importVitalDbOutcomes } = await import("@/lib/eeg/case-outcomes.server");
    return importVitalDbOutcomes(context.supabase, context.userId);
  });
