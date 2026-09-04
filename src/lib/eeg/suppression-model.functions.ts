import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { emptyReport, type SuppressionReport } from "@/lib/eeg/suppression-model";

const Input = z.object({ limit: z.number().int().min(500).max(80000).optional() }).optional();

export const getSuppressionReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<SuppressionReport> => {
    const { loadSuppressionReport } = await import("@/lib/eeg/suppression-model.server");
    try {
      return await loadSuppressionReport(context.supabase, context.userId, data?.limit ?? 40000);
    } catch {
      return emptyReport();
    }
  });

export type { SuppressionReport } from "@/lib/eeg/suppression-model";
