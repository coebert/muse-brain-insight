import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SuppressionDashboard } from "@/lib/eeg/suppression-dashboard";

const Input = z
  .object({
    limit: z.number().int().min(500).max(80000).optional(),
    cases: z.number().int().min(1).max(24).optional(),
  })
  .optional();

/**
 * Per-case suppression-versus-COEBIS traces plus the gate for the fit.
 *
 * The screen normally reads the stored result through the cached-analysis
 * layer; this stays for on-demand use and shares one implementation with the
 * background pass.
 */
export const getSuppressionDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<SuppressionDashboard> => {
    const { loadSuppressionDashboard, emptySuppressionDashboard } = await import(
      "@/lib/eeg/suppression-dashboard.server"
    );
    try {
      return await loadSuppressionDashboard(context.supabase as never, context.userId, {
        ...(data?.limit != null ? { limit: data.limit } : {}),
        ...(data?.cases != null ? { cases: data.cases } : {}),
      });
    } catch {
      return emptySuppressionDashboard();
    }
  });

export type { SuppressionDashboard } from "@/lib/eeg/suppression-dashboard";
