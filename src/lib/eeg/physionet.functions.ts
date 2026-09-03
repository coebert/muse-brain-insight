import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PhysionetImportRow } from "@/lib/eeg/physionet";
import type {
  PhysionetImportResult,
  PhysionetPoolSummary,
} from "@/lib/eeg/physionet.server";

/** Store PhysioNet-derived DSA features and burst-suppression labels. */
export const importPhysionet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { epochs: PhysionetImportRow[] }) => {
    if (!input?.epochs?.length) throw new Error("No epochs supplied.");
    if (input.epochs.length > 50_000) {
      throw new Error("Too many epochs in one import — split the files.");
    }
    return input;
  })
  .handler(async ({ data, context }): Promise<PhysionetImportResult> => {
    const { importPhysionetEpochs } = await import("@/lib/eeg/physionet.server");
    return importPhysionetEpochs(context.supabase, context.userId, data.epochs);
  });

/** What the external spectral pool currently holds, per lineage. */
export const getPhysionetPool = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PhysionetPoolSummary> => {
    const { loadPhysionetPool } = await import("@/lib/eeg/physionet.server");
    return loadPhysionetPool(context.supabase);
  });
