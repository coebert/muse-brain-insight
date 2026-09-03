import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DiscoveryResult } from "@/lib/eeg/covariate-discovery";

const inputSchema = z
  .object({
    externalLimit: z.number().int().min(500).max(60000).optional(),
    appLimit: z.number().int().min(500).max(40000).optional(),
  })
  .optional();

/** Per-lineage associations between patient covariates and EEG features. */
export const getCovariateDiscovery = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ context, data }): Promise<DiscoveryResult> => {
    const { runCovariateDiscovery } = await import("@/lib/eeg/covariate-discovery.server");
    return runCovariateDiscovery(context.supabase, {
      externalLimit: data?.externalLimit ?? 20000,
      appLimit: data?.appLimit ?? 10000,
    });
  });
