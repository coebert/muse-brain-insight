import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DrugExposureReport } from "@/lib/eeg/drug-exposure";

const inputSchema = z
  .object({ limit: z.number().int().min(1000).max(60000).optional() })
  .optional();

/** Per-case drug exposure with COEBIS and suppression grades. */
export const getDrugExposure = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ context, data }): Promise<DrugExposureReport> => {
    const { loadDrugExposure } = await import("@/lib/eeg/drug-exposure.server");
    return loadDrugExposure(context.supabase, data?.limit ?? 20000);
  });
