import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DrugLibraryReport } from "@/lib/eeg/drug-library";

const inputSchema = z
  .object({ limit: z.number().int().min(1000).max(60000).optional() })
  .optional();

/** Every registered anaesthetic agent, its EEG signature and its case coverage. */
export const getDrugLibrary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ context, data }): Promise<DrugLibraryReport> => {
    const { loadDrugLibrary } = await import("@/lib/eeg/drug-library.server");
    return loadDrugLibrary(context.supabase, data?.limit ?? 30000);
  });
