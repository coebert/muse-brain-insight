import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normaliseFacts, type CaseFacts, type CaseFactsRecord } from "@/lib/eeg/case-facts";

const EXTRACT_PROMPT = `You are a clinical neurophysiology research assistant. You are given anonymised cases written by an anaesthetist/intensivist who records frontal EEG (Muse 2) during general anaesthesia and ICU sedation.

For EACH case, read the free-text summary and notes and extract the clinical details into fixed, normalised fields. Normalise wording so the same concept reads identically across cases (e.g. always "emergency laparotomy", "sepsis", "propofol TCI", "slow emergence"). Use short noun phrases, British clinical English, lower case unless a proper noun.

Rules:
- Never invent detail. If the note does not say, leave the field empty or "unknown".
- Never copy anything identifying; omit it.
- At most 8 items per list, each under 8 words.

Respond with JSON ONLY, no fences:
{"cases":[{"sessionId":string,"procedure":string,"urgency":"elective"|"emergency"|"unknown","comorbidities":[string],"drugs":[string],"intraoperativeEvents":[string],"emergence":"normal"|"slow"|"agitated"|"not_applicable"|"unknown","postopIssues":[string],"keyDetails":[string],"riskFactors":[string]}]}`;

interface SessionRow {
  id: string;
  case_code: string | null;
  case_summary: string | null;
  notes: string | null;
  admission_diagnosis: string | null;
  clinical_features: string[] | null;
  created_at: string;
}

interface FactsRow {
  session_id: string;
  fields_sealed: string | null;
  confirmed: boolean;
}

const SELECT_SESSIONS =
  "id, case_code, case_summary, notes, admission_diagnosis, clinical_features, created_at";

function excerpt(text: string | null): string {
  const t = (text ?? "").trim();
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

/** Cases with written notes, each with its saved (or empty) structured fields. */
export const loadCaseFacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { limit?: number } | undefined) => ({
    limit: Math.min(40, Math.max(1, input?.limit ?? 25)),
  }))
  .handler(async ({ data, context }): Promise<CaseFactsRecord[]> => {
    const { open } = await import("@/lib/privacy.server");
    const { supabase, userId } = context;

    const { data: rows, error } = await supabase
      .from("eeg_sessions")
      .select(SELECT_SESSIONS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);

    const sessions = ((rows ?? []) as SessionRow[]).filter((s) =>
      ((open(s.case_summary) ?? open(s.notes) ?? "") as string).trim(),
    );
    if (!sessions.length) return [];

    const { data: factRows, error: factsError } = await supabase
      .from("case_note_facts")
      .select("session_id, fields_sealed, confirmed")
      .eq("user_id", userId)
      .in(
        "session_id",
        sessions.map((s) => s.id),
      );
    if (factsError) throw new Error(factsError.message);

    const saved = new Map<string, FactsRow>(
      ((factRows ?? []) as FactsRow[]).map((r) => [r.session_id, r]),
    );

    return sessions.map((s) => {
      const row = saved.get(s.id);
      let facts: CaseFacts = normaliseFacts(null);
      if (row?.fields_sealed) {
        try {
          facts = normaliseFacts(JSON.parse(open(row.fields_sealed) ?? "{}"));
        } catch {
          /* keep the empty shape if the stored blob is unreadable */
        }
      }
      return {
        sessionId: s.id,
        caseCode: open(s.case_code) ?? "unlabelled",
        recordedAt: s.created_at,
        summaryExcerpt: excerpt(open(s.case_summary) ?? open(s.notes)),
        facts,
        confirmed: row?.confirmed ?? false,
        draft: false,
      };
    });
  });

/** Ask the AI to propose normalised fields for cases that have none yet. */
export const proposeCaseFacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sessionIds: string[] }) => ({
    sessionIds: (input.sessionIds ?? []).slice(0, 20),
  }))
  .handler(async ({ data, context }): Promise<{ sessionId: string; facts: CaseFacts }[]> => {
    if (!data.sessionIds.length) return [];
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const { open } = await import("@/lib/privacy.server");
    const { streamGatewayText, parseJsonObject } = await import("@/lib/eeg/case-notes.server");
    const { supabase, userId } = context;

    const { data: rows, error } = await supabase
      .from("eeg_sessions")
      .select(SELECT_SESSIONS)
      .eq("user_id", userId)
      .in("id", data.sessionIds);
    if (error) throw new Error(error.message);

    const cases = ((rows ?? []) as SessionRow[])
      .map((s) => ({
        sessionId: s.id,
        admissionDiagnosis: open(s.admission_diagnosis),
        clinicalFeatures: s.clinical_features ?? [],
        caseSummaryFreeText: open(s.case_summary),
        notesFreeText: open(s.notes),
      }))
      .filter((c) => (c.caseSummaryFreeText ?? c.notesFreeText ?? "").trim().length > 0);
    if (!cases.length) return [];

    const text = await streamGatewayText(
      {
        model: "openai/gpt-5.6-sol",
        input: [
          { role: "system", content: [{ type: "input_text", text: EXTRACT_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify({ cases }) }] },
        ],
        stream: true,
        reasoning: { effort: "low", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        store: false,
      },
      apiKey,
    );
    if (!text.trim()) throw new Error("The AI returned an empty extraction. Please try again.");

    const parsed = parseJsonObject<{ cases?: unknown[] }>(text);
    const valid = new Set(cases.map((c) => c.sessionId));
    return (Array.isArray(parsed.cases) ? parsed.cases : [])
      .map((raw) => {
        const sessionId = String((raw as Record<string, unknown>)["sessionId"] ?? "");
        return { sessionId, facts: normaliseFacts(raw) };
      })
      .filter((c) => valid.has(c.sessionId));
  });

/** Store the clinician-confirmed fields for one case (encrypted at rest). */
export const saveCaseFacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sessionId: string; facts: unknown; confirmed?: boolean }) => ({
    sessionId: input.sessionId,
    facts: normaliseFacts(input.facts),
    confirmed: input.confirmed ?? true,
  }))
  .handler(async ({ data, context }) => {
    const { seal } = await import("@/lib/privacy.server");
    const { supabase, userId } = context;

    const { error } = await supabase.from("case_note_facts").upsert(
      {
        user_id: userId,
        session_id: data.sessionId,
        fields_sealed: seal(JSON.stringify(data.facts)),
        confirmed: data.confirmed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,session_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
