import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ExternalPriorSummary } from "@/lib/eeg/vitaldb";
import type { VitalDbCasePayload, VitalDbImportResult } from "@/lib/eeg/vitaldb.server";

/** Store mapped VitalDB cases as external reference readings. */
export const importVitalDb = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { cases: VitalDbCasePayload[] }) => {
    if (!input?.cases?.length) throw new Error("No mapped cases supplied.");
    const total = input.cases.reduce((n, c) => n + (c.points?.length ?? 0), 0);
    if (!total) throw new Error("The selected files contained no usable BIS readings.");
    if (total > 100_000) throw new Error("Too many readings in one import — split the files.");
    return input;
  })
  .handler(async ({ data, context }): Promise<VitalDbImportResult> => {
    const { importVitalDbCases } = await import("@/lib/eeg/vitaldb.server");
    return importVitalDbCases(context.supabase, context.userId, data.cases);
  });

/** Population priors held in the external pool, per covariate level. */
export const getExternalPriors = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ExternalPriorSummary> => {
    const { loadExternalPriors } = await import("@/lib/eeg/vitaldb.server");
    return loadExternalPriors(context.supabase);
  });
