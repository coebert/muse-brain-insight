import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { OutcomeMatch } from "@/lib/eeg/outcome-import";
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

/**
 * Apply a recovery/discharge export to the filed recordings, matched by case
 * code. `dryRun` returns the match report without writing anything, so the
 * clinician always sees what would change first.
 */
export const importOutcomeExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { csv: string; dryRun?: boolean }) => {
    if (!input?.csv?.trim()) throw new Error("Paste or upload an export first.");
    if (input.csv.length > 2_000_000) throw new Error("That file is too large to read here.");
    return input;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      dryRun: boolean;
      imported: number;
      issues: string[];
      ignoredColumns: string[];
      matched: OutcomeMatch[];
      unmatched: string[];
      stillMissing: string[];
    }> => {
      const { parseOutcomeExportCsv, matchOutcomeRows } = await import("@/lib/eeg/outcome-import");
      const { loadOutcomeCases } = await import("@/lib/eeg/outcomes.server");

      const parsed = parseOutcomeExportCsv(data.csv);
      const cases = await loadOutcomeCases(context.supabase);
      const report = matchOutcomeRows(parsed.rows, cases);
      const dryRun = data.dryRun !== false;

      if (!dryRun && report.matched.length) {
        const { error } = await context.supabase.from("case_outcomes").upsert(
          report.matched.map((m) => ({
            user_id: context.userId,
            session_id: m.sessionId,
            delirium: m.row.delirium,
            delirium_days: m.row.deliriumDays,
            emergence: m.row.emergence,
            awareness: m.row.awareness,
            unplanned_icu: m.row.unplannedIcu,
            mortality_30d: m.row.mortality30d,
            length_of_stay_days: m.row.lengthOfStayDays,
            notes: m.row.notes,
          })),
          { onConflict: "session_id" },
        );
        if (error) throw new Error(error.message);
      }

      return {
        dryRun,
        imported: dryRun ? 0 : report.matched.length,
        issues: parsed.issues,
        ignoredColumns: parsed.ignoredColumns,
        matched: report.matched,
        unmatched: report.unmatched,
        stillMissing: report.stillMissing,
      };
    },
  );
