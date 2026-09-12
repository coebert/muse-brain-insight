import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  validateDraft,
  type CaseObservation,
  type EventType,
  type ObservationDraft,
  type Stimulus,
} from "@/lib/eeg/case-observations";

interface Row {
  id: string;
  case_code: string;
  session_id: string | null;
  kind: string;
  at_seconds: number;
  moaas: number | null;
  stimulus: string | null;
  drug_name: string | null;
  dose: number | string | null;
  dose_unit: string | null;
  route: string | null;
  event_type: string | null;
  note: string | null;
}

function toObservation(row: Row): CaseObservation {
  return {
    id: row.id,
    caseCode: row.case_code,
    sessionId: row.session_id,
    kind:
      row.kind === "drug"
        ? "drug"
        : row.kind === "event"
          ? "event"
          : row.kind === "note"
            ? "note"
            : "responsiveness",
    atSeconds: Number(row.at_seconds),
    moaas: row.moaas == null ? null : Number(row.moaas),
    stimulus: (row.stimulus as Stimulus | null) ?? null,
    drugName: row.drug_name,
    dose: row.dose == null ? null : Number(row.dose),
    doseUnit: row.dose_unit,
    route: row.route,
    eventType: (row.event_type as EventType | null) ?? null,
    note: row.note,
  };
}

const SELECT =
  "id, case_code, session_id, kind, at_seconds, moaas, stimulus, drug_name, dose, dose_unit, route, event_type, note";


/** File one bedside observation immediately, so a closed app cannot lose it. */
export const recordCaseObservation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { caseCode: string; draft: ObservationDraft }) => {
    const caseCode = input.caseCode?.trim();
    if (!caseCode) throw new Error("A case code is needed before observations can be filed.");
    const check = validateDraft(input.draft);
    if (!check.ok) throw new Error(check.errors.join(" "));
    return { caseCode, draft: input.draft };
  })
  .handler(async ({ data, context }): Promise<CaseObservation> => {
    const { caseCode, draft } = data;
    const responsiveness = draft.kind === "responsiveness" ? draft : null;
    const drug = draft.kind === "drug" ? draft : null;
    const payload = {
      user_id: context.userId,
      case_code: caseCode,
      kind: draft.kind,
      at_seconds: Math.round(draft.atSeconds),
      note: draft.note?.trim() || null,
      moaas: responsiveness ? responsiveness.moaas : null,
      stimulus: responsiveness ? responsiveness.stimulus : null,
      drug_name: drug ? drug.drugName.trim() : null,
      dose: drug ? (drug.dose ?? null) : null,
      dose_unit: drug && drug.dose != null ? (drug.doseUnit ?? null) : null,
      route: drug ? (drug.route ?? null) : null,
    };


    const { data: row, error } = await context.supabase
      .from("case_observations")
      .insert(payload)
      .select(SELECT)
      .single();
    if (error) throw new Error(error.message);
    return toObservation(row as unknown as Row);
  });

/** Everything captured for one case, oldest first. */
export const listCaseObservations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { caseCode: string }) => ({ caseCode: input.caseCode?.trim() ?? "" }))
  .handler(async ({ data, context }): Promise<CaseObservation[]> => {
    if (!data.caseCode) return [];
    const { data: rows, error } = await context.supabase
      .from("case_observations")
      .select(SELECT)
      .eq("user_id", context.userId)
      .eq("case_code", data.caseCode)
      .order("at_seconds", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    return ((rows ?? []) as unknown as Row[]).map(toObservation);
  });

/** Remove one mistyped entry, rather than leaving it to be learned from. */
export const deleteCaseObservation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => ({ id: input.id }))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { error } = await context.supabase
      .from("case_observations")
      .delete()
      .eq("user_id", context.userId)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Attach a case's observations to the recording once it is filed. */
export const linkCaseObservations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { caseCode: string; sessionId: string }) => ({
    caseCode: input.caseCode?.trim() ?? "",
    sessionId: input.sessionId,
  }))
  .handler(async ({ data, context }): Promise<{ linked: number }> => {
    if (!data.caseCode || !data.sessionId) return { linked: 0 };
    const { data: rows, error } = await context.supabase
      .from("case_observations")
      .update({ session_id: data.sessionId })
      .eq("user_id", context.userId)
      .eq("case_code", data.caseCode)
      .is("session_id", null)
      .select("id");
    if (error) throw new Error(error.message);
    return { linked: (rows ?? []).length };
  });
