import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PathologyLabelEvaluation } from "@/lib/eeg/pathology-labels";

const inputSchema = z
  .object({ limit: z.number().int().min(200).max(20000).optional() })
  .optional();

/** COEBIS and detector scores graded against independently recorded labels. */
export const getPathologyLabels = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ context, data }): Promise<PathologyLabelEvaluation> => {
    const { loadPathologyLabelEvaluation } = await import("@/lib/eeg/pathology-labels.server");
    return loadPathologyLabelEvaluation(context.supabase, data?.limit ?? 8000);
  });
