import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { emptyReport, type SuppressionReport } from "@/lib/eeg/suppression-model";
import type {
  PromotedSuppressionModel,
  PromotionOutcome,
} from "@/lib/eeg/suppression-promotion.server";

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

/** The calibration currently in force, if one was ever promoted. */
export const getActiveSuppressionModel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PromotedSuppressionModel | null> => {
    const { loadActiveSuppressionModel } = await import("@/lib/eeg/suppression-promotion.server");
    const { SR_LINEAGE_PREFIX } = await import("@/lib/eeg/suppression-model.server");
    try {
      return await loadActiveSuppressionModel(context.supabase, context.userId, SR_LINEAGE_PREFIX);
    } catch {
      return null;
    }
  });

/**
 * Refit on every labelled reading and promote the result — but only when the
 * cross-validated fit clears the gate. The gate check lives in the fit itself,
 * so this cannot promote a calibration the grading refused.
 */
export const promoteSuppressionModel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<PromotionOutcome> => {
    const { loadSuppressionReport } = await import("@/lib/eeg/suppression-model.server");
    const { promoteSuppressionFit } = await import("@/lib/eeg/suppression-promotion.server");
    const report = await loadSuppressionReport(
      context.supabase,
      context.userId,
      data?.limit ?? 80000,
    );
    return promoteSuppressionFit(context.supabase, context.userId, report.fit);
  });

export type { SuppressionReport } from "@/lib/eeg/suppression-model";
export type { PromotedSuppressionModel, PromotionOutcome };
