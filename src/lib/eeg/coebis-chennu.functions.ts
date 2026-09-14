import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ChennuCoebisReport } from "@/lib/eeg/coebis-chennu.server";

/** Read COEBIS-2 on the stored Cambridge propofol epochs and grade the labels. */
export const runCoebisOnChennu = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ChennuCoebisReport> => {
    const { runChennuCoebis } = await import("@/lib/eeg/coebis-chennu.server");
    return runChennuCoebis(context.supabase, context.userId);
  });
