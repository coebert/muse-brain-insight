import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  PairedLineageRow,
  VitalDbPairedImportResult,
  VitalDbPairedPayload,
} from "@/lib/eeg/vitaldb-waveform.server";

/** Store replayed VitalDB waveform cases as paired {app index, BIS} readings. */
export const importVitalDbPaired = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { cases: VitalDbPairedPayload[] }) => {
    if (!input?.cases?.length) throw new Error("No replayed cases supplied.");
    if (input.cases.some((c) => !c.lineageKey)) {
      throw new Error("Every replayed case must carry an acquisition lineage.");
    }
    const total = input.cases.reduce((n, c) => n + (c.points?.length ?? 0), 0);
    if (!total) throw new Error("No monitor reading could be paired with a replayed second.");
    if (total > 100_000) throw new Error("Too many readings in one import — split the files.");
    return input;
  })
  .handler(async ({ data, context }): Promise<VitalDbPairedImportResult> => {
    const { importVitalDbPairedCases } = await import("@/lib/eeg/vitaldb-waveform.server");
    return importVitalDbPairedCases(context.supabase, context.userId, data.cases);
  });

/** Paired readings per lineage, as the refit sufficiency gate counts them. */
export const getPairedLineageCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PairedLineageRow[]> => {
    const { loadPairedLineageCounts } = await import("@/lib/eeg/vitaldb-waveform.server");
    return loadPairedLineageCounts(context.supabase);
  });
