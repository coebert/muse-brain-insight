import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { StateComparisonReport } from "@/lib/eeg/state-comparison.server";

/** Grade the small state models against COEBIS on the same sedation epochs. */
export const runStateModelComparison = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StateComparisonReport> => {
    const { compareStateModels } = await import("@/lib/eeg/state-comparison.server");
    return compareStateModels(context.supabase, context.userId);
  });
