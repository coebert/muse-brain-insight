import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { emptyLiveAccuracy, type LiveAccuracyReport } from "@/lib/eeg/lineage-live-accuracy";

const Input = z.object({ limit: z.number().int().min(1000).max(200000).optional() }).optional();

export const getLiveAccuracy = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<LiveAccuracyReport> => {
    const { loadLiveAccuracy } = await import("@/lib/eeg/lineage-live-accuracy.server");
    try {
      return await loadLiveAccuracy(context.supabase, context.userId, data?.limit ?? 120000);
    } catch {
      return emptyLiveAccuracy();
    }
  });

export type { LiveAccuracyReport, LineageLiveAccuracy } from "@/lib/eeg/lineage-live-accuracy";
