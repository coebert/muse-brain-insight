import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ChennuPhaseReport } from "@/lib/eeg/coebis-chennu-phases.server";

/** Score the Cambridge propofol blocks with COEBIS and read the arc by phase. */
export const runChennuPhases = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ChennuPhaseReport> => {
    const { runChennuPhaseFit } = await import("@/lib/eeg/coebis-chennu-phases.server");
    return runChennuPhaseFit(context.supabase, context.userId);
  });
