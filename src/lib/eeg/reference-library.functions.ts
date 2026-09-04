import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const RowInput = z.object({
  at: z.number(),
  bis: z.number().nullable(),
  sr: z.number().nullable(),
  sef: z.number().nullable(),
  sqi: z.number().nullable(),
  moaas: z.number().nullable(),
  state: z.string().nullable(),
  duration: z.number().nullable(),
});

const ImportInput = z.object({
  sessionId: z.string().uuid(),
  formatId: z.string().min(1),
  lineageKey: z.string().min(1),
  rows: z.array(RowInput).min(1).max(5000),
});

/** Catalogue coverage plus the recordings a file can be attached to. */
export const getReferenceLibrary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadReferenceLibrary } = await import("./reference-library.server");
    return loadReferenceLibrary(context.supabase, context.userId);
  });

/** File one parsed reference file against a recording. */
export const importReferenceFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => ImportInput.parse(data))
  .handler(async ({ data, context }) => {
    const { importReferenceRows } = await import("./reference-library.server");
    return importReferenceRows(context.supabase, context.userId, data);
  });
