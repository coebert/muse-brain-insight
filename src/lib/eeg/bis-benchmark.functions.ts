import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { BisBenchmark } from "@/lib/eeg/bis-benchmark";

/** COEBIS against the recorded bedside BIS, on every paired reading held. */
export const getBisBenchmark = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { limit?: number }) => ({
    limit: Math.min(Math.max(Number(input?.limit ?? 200000), 1000), 400000),
  }))
  .handler(async ({ data, context }): Promise<BisBenchmark> => {
    const { loadBisBenchmark } = await import("@/lib/eeg/bis-benchmark.server");
    return loadBisBenchmark(context.supabase, context.userId, data.limit);
  });
