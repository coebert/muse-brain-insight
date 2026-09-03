import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { IntakeRunResult } from "@/lib/eeg/dataset-intake";
import type {
  IntakeHistoryEntry,
  IntakeProvenanceEntry,
} from "@/lib/eeg/dataset-intake.server";

/** Scan configured public sources, fetch eligible files and ingest them. */
export const runIntake = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { sourceIds?: string[]; maxFilesPerSource?: number; dryRun?: boolean }) => ({
      sourceIds: Array.isArray(input?.sourceIds) ? input.sourceIds.slice(0, 8) : undefined,
      maxFilesPerSource:
        typeof input?.maxFilesPerSource === "number"
          ? Math.max(1, Math.min(20, Math.round(input.maxFilesPerSource)))
          : undefined,
      dryRun: input?.dryRun === true,
    }),
  )
  .handler(async ({ data, context }): Promise<IntakeRunResult> => {
    const { runDatasetIntake } = await import("@/lib/eeg/dataset-intake.server");
    return runDatasetIntake(context.supabase, context.userId, data);
  });

/** Past intake runs and the licence/provenance record per source. */
export const getIntakeHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<{ runs: IntakeHistoryEntry[]; provenance: IntakeProvenanceEntry[] }> => {
      const { loadIntakeHistory } = await import("@/lib/eeg/dataset-intake.server");
      return loadIntakeHistory(context.supabase);
    },
  );
