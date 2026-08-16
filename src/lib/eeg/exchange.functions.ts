import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ExchangeBundle } from "@/lib/eeg/exchange";

/** De-identified export of every paired reading, for pooling across devices. */
export const exportPairedDataset = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { site?: string | undefined }) => input ?? {})
  .handler(async ({ data, context }): Promise<ExchangeBundle> => {
    const { buildExportForUser } = await import("@/lib/eeg/exchange.server");
    return buildExportForUser(context.supabase, context.userId, data.site ?? "");
  });

export interface ImportResult {
  inserted: number;
  skipped: number;
  site: string;
  error?: string;
}

/** Merge a colleague's de-identified bundle into the training data. */
export const importPairedDataset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { bundle: unknown }) => {
    if (!input?.bundle) throw new Error("No file supplied.");
    return input;
  })
  .handler(async ({ data, context }): Promise<ImportResult> => {
    const { importBundleForUser } = await import("@/lib/eeg/exchange.server");
    return importBundleForUser(context.supabase, context.userId, data.bundle);
  });
