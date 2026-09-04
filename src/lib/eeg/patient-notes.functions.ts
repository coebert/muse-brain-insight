import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PatientNotesReport } from "@/lib/eeg/patient-notes.server";

export type { PatientNotesReport };

/** Every patient, their recorded depth numbers and the context written beside them. */
export const getPatientNotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientNotesReport> => {
    const { loadPatientNotes } = await import("@/lib/eeg/patient-notes.server");
    return loadPatientNotes(context.supabase, context.userId);
  });

const text = (value: unknown, field: string): string => {
  const v = typeof value === "string" ? value : "";
  if (v.length > 4000) throw new Error(`${field} is too long — keep it under 4000 characters.`);
  return v;
};

/** Create or replace the context note for one patient. */
export const savePatientContextNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      patientKey: string;
      patientLabel?: string | null;
      context?: string;
      baseline?: string;
      confounders?: string;
      readWith?: string;
    }) => {
      if (!input?.patientKey) throw new Error("A patient must be selected.");
      return {
        patientKey: input.patientKey,
        patientLabel: input.patientLabel ?? null,
        context: text(input.context, "Who this patient is"),
        baseline: text(input.baseline, "What normal looks like"),
        confounders: text(input.confounders, "What could mislead the number"),
        readWith: text(input.readWith, "How to read COEBIS here"),
      };
    },
  )
  .handler(async ({ data, context }): Promise<{ saved: true }> => {
    const { savePatientNote } = await import("@/lib/eeg/patient-notes.server");
    await savePatientNote(context.supabase, context.userId, data);
    return { saved: true };
  });
