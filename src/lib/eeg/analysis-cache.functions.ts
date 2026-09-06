import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ANALYSIS_JOBS, type AnalysisJobKey, type CachedAnalysis } from "@/lib/eeg/analysis-cache";

/** Payloads cross the wire as plain JSON; each screen casts to its own shape. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonPayload = { [key: string]: Json };

const jobSchema = z.object({ job: z.enum(ANALYSIS_JOBS) });
const refreshSchema = jobSchema.extend({ force: z.boolean().optional() });

/** The stored result for one screen. One indexed row read, so it is instant. */
export const getCachedAnalysis = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => jobSchema.parse(data))
  .handler(async ({ data, context }): Promise<CachedAnalysis<JsonPayload>> => {
    const { readAnalysisCache } = await import("@/lib/eeg/analysis-cache.server");
    return readAnalysisCache<JsonPayload>(context.supabase as never, context.userId, data.job as AnalysisJobKey);
  });

/**
 * Work the result out in the background and store it. Bounded to one job per
 * call, and a claim in the database stops two passes running at once.
 */
export const refreshCachedAnalysis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => refreshSchema.parse(data))
  .handler(async ({ data, context }): Promise<CachedAnalysis<JsonPayload>> => {
    const { runAnalysisJob } = await import("@/lib/eeg/analysis-cache.server");
    return runAnalysisJob<JsonPayload>(
      context.supabase as never,
      context.userId,
      data.job as AnalysisJobKey,
      { force: data.force ?? false },
    );
  });
