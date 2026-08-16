import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analyseOutcomeSignals, type OutcomeCase, type OutcomeSignal } from "@/lib/eeg/outcomes";

export interface OutcomeReport {
  cases: OutcomeCase[];
  recorded: number;
  signals: OutcomeSignal[];
}

/** Every case with its EEG exposure and any post-case outcome recorded. */
export const getOutcomeReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<OutcomeReport> => {
    const { loadOutcomeCases } = await import("@/lib/eeg/outcomes.server");
    const cases = await loadOutcomeCases(context.supabase);
    return {
      cases,
      recorded: cases.filter((c) => c.outcome != null).length,
      signals: analyseOutcomeSignals(cases),
    };
  });

/** Create or update the outcome record for one case. */
export const saveCaseOutcome = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      sessionId: string;
      delirium: string;
      deliriumDays?: number | null;
      emergence: string;
      awareness: boolean;
      unplannedIcu: boolean;
      mortality30d: boolean;
      lengthOfStayDays?: number | null;
      notes?: string | null;
    }) => {
      if (!input?.sessionId) throw new Error("A case must be selected.");
      return input;
    },
  )
  .handler(async ({ data, context }): Promise<{ saved: true }> => {
    const { error } = await context.supabase.from("case_outcomes").upsert(
      {
        user_id: context.userId,
        session_id: data.sessionId,
        delirium: data.delirium,
        delirium_days: data.deliriumDays ?? null,
        emergence: data.emergence,
        awareness: data.awareness,
        unplanned_icu: data.unplannedIcu,
        mortality_30d: data.mortality30d,
        length_of_stay_days: data.lengthOfStayDays ?? null,
        notes: data.notes ?? null,
      },
      { onConflict: "session_id" },
    );
    if (error) throw new Error(error.message);
    return { saved: true };
  });
