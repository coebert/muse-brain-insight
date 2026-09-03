import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  OpenNeuroBisCasePayload,
  OpenNeuroBisImportResult,
  OpenNeuroLineageRow,
} from "@/lib/eeg/openneuro-bis.server";

/** Store OpenNeuro BIS readings under each dataset's own lineage. */
export const importOpenNeuroBis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { cases: OpenNeuroBisCasePayload[] }) => {
    if (!input?.cases?.length) throw new Error("No mapped cases supplied.");
    if (input.cases.some((c) => !c.lineage?.startsWith("external:openneuro:"))) {
      throw new Error("Every case must carry an OpenNeuro dataset lineage.");
    }
    const total = input.cases.reduce((n, c) => n + (c.points?.length ?? 0), 0);
    if (!total) throw new Error("The selected files contained no usable BIS readings.");
    if (total > 100_000) throw new Error("Too many readings in one import — split the files.");
    return input;
  })
  .handler(async ({ data, context }): Promise<OpenNeuroBisImportResult> => {
    const { importOpenNeuroBisCases } = await import("@/lib/eeg/openneuro-bis.server");
    return importOpenNeuroBisCases(context.supabase, context.userId, data.cases);
  });

/** Readings held per OpenNeuro dataset lineage. */
export const getOpenNeuroBisLineages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OpenNeuroLineageRow[]> => {
    const { loadOpenNeuroBisLineages } = await import("@/lib/eeg/openneuro-bis.server");
    return loadOpenNeuroBisLineages(context.supabase);
  });
