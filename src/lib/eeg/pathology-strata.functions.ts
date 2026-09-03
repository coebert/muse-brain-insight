import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PathologyEvaluationResult } from "@/lib/eeg/pathology-strata.server";

export type { PathologyEvaluationResult } from "@/lib/eeg/pathology-strata.server";

const inputSchema = z
  .object({
    family: z.enum(["raw", "affine", "covariate", "mixed"]).optional(),
    limit: z.number().int().min(50).max(20000).optional(),
  })
  .optional();

/** Held-out COEBIS agreement broken down by EEG pattern and clinical labels. */
export const getPathologyStrata = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ context, data }): Promise<PathologyEvaluationResult> => {
    const { evaluatePathologyStrata } = await import("@/lib/eeg/pathology-strata.server");
    return evaluatePathologyStrata(
      context.supabase,
      data?.family ?? "covariate",
      data?.limit ?? 5000,
    );
  });
