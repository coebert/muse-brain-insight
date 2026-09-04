import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildSuppressionDashboard,
  gateStatus,
  MAX_DASHBOARD_CASES,
  type SuppressionDashboard,
} from "@/lib/eeg/suppression-dashboard";
import { crossValidate, emptyReport } from "@/lib/eeg/suppression-model";

const Input = z
  .object({
    limit: z.number().int().min(500).max(80000).optional(),
    cases: z.number().int().min(1).max(24).optional(),
  })
  .optional();

/** Per-case suppression-versus-COEBIS traces plus the gate for the fit. */
export const getSuppressionDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<SuppressionDashboard> => {
    const { loadSuppressionPoints, SR_LINEAGE_PREFIX } = await import(
      "@/lib/eeg/suppression-model.server"
    );
    try {
      const points = await loadSuppressionPoints(
        context.supabase,
        context.userId,
        data?.limit ?? 40000,
      );
      if (!points.length) {
        return { gate: gateStatus(emptyReport().fit), totals: { agreed: 0, missed: 0, falseAlarms: 0, clear: 0 }, cases: [] };
      }
      const fit = crossValidate(SR_LINEAGE_PREFIX, points);
      return buildSuppressionDashboard(points, fit, data?.cases ?? MAX_DASHBOARD_CASES);
    } catch {
      return {
        gate: gateStatus(emptyReport().fit),
        totals: { agreed: 0, missed: 0, falseAlarms: 0, clear: 0 },
        cases: [],
      };
    }
  });

export type { SuppressionDashboard } from "@/lib/eeg/suppression-dashboard";
