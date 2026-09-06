import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { HeadbandScoreReport } from "./headband-depth-scores.server";

const Input = z
  .object({
    sessions: z.number().int().min(1).max(200).optional(),
    rows: z.number().int().min(100).max(40000).optional(),
  })
  .optional();

/** Headband depth scores set against the shared suppression model. */
export const getHeadbandScores = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<HeadbandScoreReport> => {
    const { getHeadbandScoreReport } = await import("./headband-depth-scores.server");
    return getHeadbandScoreReport(context.supabase, context.userId, {
      ...(data?.sessions ? { sessions: data.sessions } : {}),
      ...(data?.rows ? { rows: data.rows } : {}),
    });
  });
