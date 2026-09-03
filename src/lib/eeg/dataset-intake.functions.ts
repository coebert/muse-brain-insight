import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CredentialRealm, IntakeRunResult } from "@/lib/eeg/dataset-intake";
import type {
  IntakeHistoryEntry,
  IntakeProvenanceEntry,
} from "@/lib/eeg/dataset-intake.server";

/** Scan configured public sources, fetch eligible files and ingest them. */
export const runIntake = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { sourceIds?: string[]; maxFilesPerSource?: number; dryRun?: boolean }) => ({
      ...(Array.isArray(input?.sourceIds) ? { sourceIds: input.sourceIds.slice(0, 8) } : {}),
      ...(typeof input?.maxFilesPerSource === "number"
        ? {
            maxFilesPerSource: Math.max(1, Math.min(20, Math.round(input.maxFilesPerSource))),
          }
        : {}),
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

/**
 * Which credential realms have a stored login. Only the realm names cross the
 * boundary — usernames and passwords stay in backend secrets.
 */
export const getIntakeCredentials = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ realms: CredentialRealm[] }> => {
    const { resolveCredentials } = await import("@/lib/eeg/dataset-intake.server");
    return { realms: resolveCredentials().realms };
  });
