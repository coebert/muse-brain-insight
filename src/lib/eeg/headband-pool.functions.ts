import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { HeadbandPoolReport } from "./headband-pool.server";

const Input = z.object({ lineageKey: z.string().min(1).max(120).optional() }).optional();

/** The headband training pool with outcomes attached, graded but not fitted. */
export const getHeadbandPool = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<HeadbandPoolReport> => {
    const { getHeadbandPoolReport } = await import("./headband-pool.server");
    return getHeadbandPoolReport(context.supabase, context.userId, data?.lineageKey);
  });

/** Refit the headband lineage on the pool and record the outcome split. */
export const refitHeadbandPool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<HeadbandPoolReport> => {
    const { runHeadbandPoolRefit } = await import("./headband-pool.server");
    return runHeadbandPoolRefit(context.supabase, context.userId, data?.lineageKey);
  });
