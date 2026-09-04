import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildSuppressionDashboard,
  gateStatus,
  MAX_DASHBOARD_CASES,
  newBisAccumulator,
  summariseBis,
  type SuppressionDashboard,
} from "@/lib/eeg/suppression-dashboard";
import { crossValidate, emptyReport } from "@/lib/eeg/suppression-model";

const Input = z
  .object({
    limit: z.number().int().min(500).max(80000).optional(),
    cases: z.number().int().min(1).max(24).optional(),
  })
  .optional();

const empty = (): SuppressionDashboard => ({
  gate: gateStatus(emptyReport().fit),
  modelSource: "raw detector",
  totals: { agreed: 0, missed: 0, falseAlarms: 0, clear: 0 },
  bisTotals: summariseBis(newBisAccumulator()),
  casesWithBis: 0,
  patients: 0,
  cases: [],
});

/** Per-case suppression-versus-COEBIS traces plus the gate for the fit. */
export const getSuppressionDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<SuppressionDashboard> => {
    const { loadSuppressionPoints, SR_LINEAGE_PREFIX } = await import(
      "@/lib/eeg/suppression-model.server"
    );
    const { loadActiveSuppressionModel } = await import(
      "@/lib/eeg/suppression-promotion.server"
    );
    try {
      const points = await loadSuppressionPoints(
        context.supabase,
        context.userId,
        data?.limit ?? 40000,
      );
      if (!points.length) return empty();

      const fit = crossValidate(SR_LINEAGE_PREFIX, points);
      // Prefer the calibration actually in force; the freshly cross-validated
      // fit is only a fallback, and is never presented as promoted.
      const active = await loadActiveSuppressionModel(
        context.supabase,
        context.userId,
        SR_LINEAGE_PREFIX,
      ).catch(() => null);

      return buildSuppressionDashboard(points, fit, {
        maxCases: data?.cases ?? MAX_DASHBOARD_CASES,
        ...(active ? { activeModel: active.model, modelSource: "promoted" as const } : {}),
      });

    } catch {
      return empty();
    }
  });


export type { SuppressionDashboard } from "@/lib/eeg/suppression-dashboard";
