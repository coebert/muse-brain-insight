import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { StateFitResult, StatePoolSummary } from "@/lib/eeg/state-labels.server";

/** What the conscious/unconscious pool holds and how well it is separated. */
export const getStatePool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { lineage?: string | null }) => ({
    lineage: input?.lineage?.trim() || null,
  }))
  .handler(async ({ data, context }): Promise<StatePoolSummary> => {
    const { loadStateSummary } = await import("@/lib/eeg/state-labels.server");
    return loadStateSummary(context.supabase, context.userId, data.lineage);
  });

/** Fit the state-separation model and promote it only on a clear gain. */
export const runStateLabelFit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { lineage?: string | null }) => ({
    lineage: input?.lineage?.trim() || null,
  }))
  .handler(async ({ data, context }): Promise<StateFitResult> => {
    const { runStateFit } = await import("@/lib/eeg/state-labels.server");
    return runStateFit(context.supabase, context.userId, data.lineage);
  });
