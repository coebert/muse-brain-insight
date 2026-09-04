import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  BisModelReport,
  BisPromotionOutcome,
  PromotedBisModel,
} from "@/lib/eeg/bis-model.server";

const Input = z
  .object({ limit: z.number().int().min(500).max(200000).optional(), note: z.string().max(200).optional() })
  .optional();

/** Fit a candidate BIS model per lineage and grade it against the live app. */
export const getBisModelReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<BisModelReport> => {
    const { loadBisModelReport } = await import("@/lib/eeg/bis-model.server");
    return loadBisModelReport(context.supabase, context.userId, data?.limit ?? 200000);
  });

/** Refit and promote every lineage whose candidate clears the gate. */
export const promoteBisModel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<BisPromotionOutcome> => {
    const { loadBisModelReport, promoteBisFits } = await import("@/lib/eeg/bis-model.server");
    const report = await loadBisModelReport(context.supabase, context.userId, data?.limit ?? 200000);
    return promoteBisFits(context.supabase, context.userId, report, data?.note);
  });

export type { BisModelReport, BisPromotionOutcome, PromotedBisModel };
