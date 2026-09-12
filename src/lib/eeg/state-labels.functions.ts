import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { StateFitResult, StatePoolSummary } from "@/lib/eeg/state-labels.server";

/** What the conscious/unconscious pool holds and how well it is separated. */
export const getStatePool = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StatePoolSummary> => {
    const { loadStateSummary } = await import("@/lib/eeg/state-labels.server");
    return loadStateSummary(context.supabase, context.userId);
  });

/** Fit the state-separation model and promote it only on a clear gain. */
export const runStateLabelFit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StateFitResult> => {
    const { runStateFit } = await import("@/lib/eeg/state-labels.server");
    return runStateFit(context.supabase, context.userId);
  });
