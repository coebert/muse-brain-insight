import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { KetamineCaseReport } from "@/lib/eeg/ketamine-cases";

const inputSchema = z
  .object({ limit: z.number().int().min(1000).max(60000).optional() })
  .optional();

/** Per-case ketamine signature, correction effect, and suppression/state grades. */
export const getKetamineCases = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ context, data }): Promise<KetamineCaseReport> => {
    const { loadKetamineCases } = await import("@/lib/eeg/ketamine-cases.server");
    return loadKetamineCases(context.supabase, data?.limit ?? 40000);
  });
