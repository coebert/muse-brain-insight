import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PairingMoment, PairingWorklist } from "./pairing-worklist";

const WorklistInput = z
  .object({ lineageKey: z.string().min(1).max(120).optional() })
  .optional();

/** Recordings on a lineage that could still supply monitor readings. */
export const getPairingWorklist = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => WorklistInput.parse(data))
  .handler(async ({ data, context }): Promise<PairingWorklist> => {
    const { loadPairingWorklist, MUSE_LINEAGE_KEY } = await import("./pairing-worklist.server");
    return loadPairingWorklist(context.supabase, context.userId, data?.lineageKey ?? MUSE_LINEAGE_KEY);
  });

const MomentsInput = z.object({
  sessionId: z.string().uuid(),
  count: z.number().int().min(1).max(12).default(6),
});

/** Moments in one recording worth pairing with a bedside monitor value. */
export const getPairingMoments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => MomentsInput.parse(data))
  .handler(async ({ data, context }): Promise<PairingMoment[]> => {
    const { loadPairingMoments } = await import("./pairing-worklist.server");
    return loadPairingMoments(context.supabase, context.userId, data.sessionId, data.count);
  });
