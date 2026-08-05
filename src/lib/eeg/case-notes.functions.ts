import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normaliseFacts, type CaseFacts } from "@/lib/eeg/case-facts";

export interface CaseNoteKeyDetails {
  sessionId: string;
  caseCode: string;
  /** Short structured facts the AI drew out of the free text. */
  keyDetails: string[];
  /** Risk factors or red flags stated or implied in the note. */
  riskFactors: string[];
  /** How the narrative squares with the recorded EEG metrics. */
  eegCorrelation: string;
}

export interface CasePattern {
  title: string;
  detail: string;
  strength: "emerging" | "moderate" | "strong";
  /** Case codes the pattern was seen in. */
  caseCodes: string[];
  /** What to check or do next to test the pattern. */
  suggestedAction: string;
}

export interface CaseNoteInsights {
  headline: string;
  casesAnalysed: number;
  notesAnalysed: number;
  perCase: CaseNoteKeyDetails[];
  patterns: CasePattern[];
  /** Detail that would sharpen future pattern finding if recorded. */
  recordingGaps: string[];
  limitations: string[];
  generatedAt: string;
}

const SYSTEM_PROMPT = `You are a clinical neurophysiology research assistant working with an anaesthetist/intensivist who records EEG from a 4-channel frontal Muse 2 headband during general anaesthesia and ICU sedation.

You are given a set of that clinician's own anonymised cases. Each case has: an anonymised case code, demographics and admission details, the clinician's FREE-TEXT case summary and notes, and the quantitative EEG summary actually recorded (suppression ratio and suppression time, seizure alerts, depth index, SEF95, duration).

Each case may also carry CONFIRMED STRUCTURED FIELDS that the clinician has already reviewed and corrected. Where those are present, treat them as the authoritative reading of the note: reuse their exact wording in keyDetails and riskFactors rather than re-deriving your own, and build patterns on them.

Your job has two parts:
1. Read each free-text summary and extract the key clinical details as short, structured, comparable facts (e.g. "frail elderly", "emergency laparotomy", "sepsis on noradrenaline", "slow emergence", "postoperative delirium", "propofol TCI Ce 2.4"). Normalise wording so the same concept reads the same way across cases. Then say in one sentence how the narrative squares with that case's recorded EEG numbers.
2. Across all cases, look for NEW clinical patterns linking those extracted details to the EEG findings — for example a subgroup that suppresses at low doses, a diagnosis associated with high seizure scores, a drug or surgical event followed by a characteristic depth change, or a narrative feature that predicts slow emergence.

Rules:
- Only assert a pattern you can point to in at least two cases, and give the case codes. Say how strong it is: "emerging" (2 cases or weak), "moderate", "strong".
- Never state a diagnosis and never invent numbers — cite only values present in the data given.
- Be explicit that these are hypotheses from a small, uncontrolled, single-clinician frontal-montage dataset, not evidence.
- British clinical English, concise and specific. Never repeat identifiable detail; if a note contains anything identifying, ignore it and flag it under recordingGaps.

Respond with JSON ONLY, no markdown fences, in this exact shape:
{"headline":string,"perCase":[{"sessionId":string,"caseCode":string,"keyDetails":[string],"riskFactors":[string],"eegCorrelation":string}],"patterns":[{"title":string,"detail":string,"strength":"emerging"|"moderate"|"strong","caseCodes":[string],"suggestedAction":string}],"recordingGaps":[string],"limitations":[string]}
At most 8 key details and 5 risk factors per case, at most 6 patterns, at most 5 recordingGaps and 4 limitations. Keep each string under about 45 words.`;

interface SessionRow {
  id: string;
  case_code: string | null;
  case_summary: string | null;
  notes: string | null;
  admission_diagnosis: string | null;
  context: string | null;
  age_band: string | null;
  sex: string | null;
  clinical_features: string[] | null;
  duration_seconds: number | null;
  mean_suppression_ratio: number | null;
  max_suppression_ratio: number | null;
  suppression_seconds: number | null;
  seizure_alerts: number | null;
  created_at: string;
}

/** Read the clinician's free-text case summaries and mine them for clinical patterns. */
export const mineCaseNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { limit?: number } | undefined) => ({
    limit: Math.min(40, Math.max(2, input?.limit ?? 25)),
  }))
  .handler(async ({ data, context }): Promise<CaseNoteInsights> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const { open } = await import("@/lib/privacy.server");
    const { streamGatewayText, parseJsonObject } = await import("@/lib/eeg/case-notes.server");

    const { data: rows, error } = await context.supabase
      .from("eeg_sessions")
      .select(
        "id, case_code, case_summary, notes, admission_diagnosis, context, age_band, sex, clinical_features, duration_seconds, mean_suppression_ratio, max_suppression_ratio, suppression_seconds, seizure_alerts, created_at",
      )
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);

    const sessions = (rows ?? []) as SessionRow[];

    // Clinician-confirmed structured fields take precedence over the model's
    // own reading of the same note.
    const confirmed = new Map<string, CaseFacts>();
    if (sessions.length) {
      const { data: factRows } = await context.supabase
        .from("case_note_facts")
        .select("session_id, fields_sealed, confirmed")
        .eq("user_id", context.userId)
        .eq("confirmed", true)
        .in(
          "session_id",
          sessions.map((s) => s.id),
        );
      for (const row of factRows ?? []) {
        if (!row.fields_sealed) continue;
        try {
          confirmed.set(
            row.session_id,
            normaliseFacts(JSON.parse(open(row.fields_sealed) ?? "{}")),
          );
        } catch {
          /* skip unreadable rows */
        }
      }
    }

    const cases = sessions
      .map((s) => ({
        sessionId: s.id,
        caseCode: open(s.case_code) ?? "unlabelled",
        recordedAt: s.created_at,
        clinicalContext: s.context,
        ageBand: s.age_band,
        sex: s.sex,
        admissionDiagnosis: open(s.admission_diagnosis),
        clinicalFeatures: s.clinical_features ?? [],
        confirmedFields: confirmed.get(s.id) ?? null,
        caseSummaryFreeText: open(s.case_summary),
        notesFreeText: open(s.notes),
        eeg: {
          durationSeconds: s.duration_seconds ?? 0,
          meanSuppressionRatioPct: s.mean_suppression_ratio ?? 0,
          maxSuppressionRatioPct: s.max_suppression_ratio ?? 0,
          suppressionSeconds: s.suppression_seconds ?? 0,
          seizureAlerts: s.seizure_alerts ?? 0,
        },
      }))
      .filter((c) => (c.caseSummaryFreeText ?? c.notesFreeText ?? "").trim().length > 0);

    if (cases.length < 2) {
      return {
        headline:
          "Not enough written cases yet — add a free-text summary to at least two filed cases and the AI can start comparing them.",
        casesAnalysed: sessions.length,
        notesAnalysed: cases.length,
        perCase: [],
        patterns: [],
        recordingGaps: [
          "Write a short free-text summary when you file each case — that narrative is what the pattern search reads.",
        ],
        limitations: [],
        generatedAt: new Date().toISOString(),
      };
    }

    const text = await streamGatewayText(
      {
        model: "openai/gpt-5.6-sol",
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify({ cases }) }],
          },
        ],
        stream: true,
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        store: false,
      },
      apiKey,
    );
    if (!text.trim()) throw new Error("The AI returned an empty analysis. Please try again.");

    const parsed = parseJsonObject<Partial<CaseNoteInsights>>(text);
    return {
      headline: parsed.headline ?? "Case notes reviewed.",
      casesAnalysed: sessions.length,
      notesAnalysed: cases.length,
      perCase: Array.isArray(parsed.perCase) ? parsed.perCase : [],
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      recordingGaps: Array.isArray(parsed.recordingGaps) ? parsed.recordingGaps : [],
      limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
      generatedAt: new Date().toISOString(),
    };
  });
