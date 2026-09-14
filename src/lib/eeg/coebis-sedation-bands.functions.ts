import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SedationTune } from "@/lib/eeg/coebis-sedation-bands";
import type { SedationTuneReport } from "@/lib/eeg/coebis-sedation-bands.server";

/** Fit, grade and (if it clears both bars) adopt the sedation band curve. */
export const runSedationBandTune = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SedationTuneReport> => {
    const { runSedationTune } = await import("@/lib/eeg/coebis-sedation-bands.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return runSedationTune(context.supabase, context.userId, supabaseAdmin as any);
  });

/** The curve currently in force for this clinician, if any. */
export const getSedationBandTune = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SedationTune | null> => {
    const { loadActiveSedationTune } = await import("@/lib/eeg/coebis-sedation-bands.server");
    return loadActiveSedationTune(context.supabase, context.userId);
  });
