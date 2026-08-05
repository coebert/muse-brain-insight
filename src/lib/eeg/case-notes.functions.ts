import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normaliseFacts, type CaseFacts, type CaseTimelinePoint } from "@/lib/eeg/case-facts";
import {
  countVerdicts,
  normaliseInfluence,
  type FeedbackImpact,
  type FeedbackInfluence,
} from "@/lib/eeg/feedback-influence";
import { normaliseFeedback, patternKey, type PatternFeedback } from "@/lib/eeg/pattern-feedback";

export type { FeedbackImpact, FeedbackInfluence };

/** A stretch of one recording cited as support for a detail or pattern. */
export interface EegCitation {
  sessionId: string;
  caseCode: string;
  startSeconds: number;
  endSeconds: number;
  /** What the EEG shows there, and which detail it supports. */
  why: string;
}

export interface CaseNoteKeyDetails {
  sessionId: string;
  caseCode: string;
  /** Short structured facts the AI drew out of the free text. */
  keyDetails: string[];
  /** Risk factors or red flags stated or implied in the note. */
  riskFactors: string[];
  /** How the narrative squares with the recorded EEG metrics. */
  eegCorrelation: string;
  /** Segments of this case's recording that back the details above. */
  citations: EegCitation[];
}

export interface CasePattern {
  title: string;
  detail: string;
  strength: "emerging" | "moderate" | "strong";
  /** Case codes the pattern was seen in. */
  caseCodes: string[];
  /** What to check or do next to test the pattern. */
  suggestedAction: string;
  /** The exact EEG segments, across cases, the pattern rests on. */
  citations: EegCitation[];
  /** Stable identity used to attach the clinician's verdict. */
  patternKey?: string;
  /** How the clinician's earlier verdicts moved this pattern's ranking. */
  feedbackInfluence?: FeedbackInfluence;
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
  /** Verdicts the clinician has already recorded on earlier patterns. */
  feedback: PatternFeedback[];
  /** How those verdicts changed this run's ranking. */
  feedbackImpact: FeedbackImpact;
}

const SYSTEM_PROMPT = `You are a clinical neurophysiology research assistant working with an anaesthetist/intensivist who records EEG from a 4-channel frontal Muse 2 headband during general anaesthesia and ICU sedation.

You are given a set of that clinician's own anonymised cases. Each case has: an anonymised case code, demographics and admission details, the clinician's FREE-TEXT case summary and notes, and the quantitative EEG summary actually recorded (suppression ratio and suppression time, seizure alerts, depth index, SEF95, duration).

Each case also carries its recorded EEG TIMELINE: detections (burst suppression, isoelectric, seizure suspicion, signal loss) and clinician markers with start times in seconds from the beginning of that recording, plus the case duration.

Every key detail and every pattern you assert must be tied back to the recording: cite the exact segments (sessionId, caseCode, startSeconds, endSeconds) that show it, with one short phrase saying what is visible there. Use only times that exist in the timeline given, inside the case duration, and never invent a segment. If nothing in the recording supports a claim, say so in the text and leave citations empty rather than inventing one.

Each case may also carry CONFIRMED STRUCTURED FIELDS that the clinician has already reviewed and corrected. Where those are present, treat them as the authoritative reading of the note: reuse their exact wording in keyDetails and riskFactors rather than re-deriving your own, and build patterns on them.

You are also given PRIOR CLINICIAN FEEDBACK: patterns proposed before, each marked accepted, edited or rejected, often with the clinician's own reworded title/detail and a reason. Learn from it:
- ACCEPTED: established for this clinician. Re-propose only if new cases strengthen or qualify it, and say what changed.
- EDITED: their wording and framing are correct. Reuse their title and detail verbatim and build on that reading.
- REJECTED: do not propose that pattern or a trivial rewording of it again. Apply the stated reason to related hypotheses, and revisit only if clearly stronger evidence has appeared — then say why the earlier objection no longer holds.

Make that learning visible. For EVERY pattern you propose, fill feedbackInfluence: whether prior verdicts "raised", "lowered" or left "unchanged" its confidence, or "new" if no earlier verdict bears on it; the strength it would have carried with no feedback (strengthWithoutFeedback, or "not proposed"); one sentence in "because" naming the accepted/edited/rejected verdicts that moved it; "drivers" listing the specific case details or EEG features that drove the shift (e.g. "clinician's reworded framing of slow emergence", "two further cases with BSR > 20%"); and "relatedTitles" naming the earlier judged patterns you weighed it against. Also fill feedbackImpact.summary with one or two sentences on how the verdict library changed this run's ranking overall, and feedbackImpact.suppressed with the ideas you held back because they repeat a rejected pattern.

Your job has two parts:
1. Read each free-text summary and extract the key clinical details as short, structured, comparable facts (e.g. "frail elderly", "emergency laparotomy", "sepsis on noradrenaline", "slow emergence", "postoperative delirium", "propofol TCI Ce 2.4"). Normalise wording so the same concept reads the same way across cases. Then say in one sentence how the narrative squares with that case's recorded EEG numbers.
2. Across all cases, look for NEW clinical patterns linking those extracted details to the EEG findings — for example a subgroup that suppresses at low doses, a diagnosis associated with high seizure scores, a drug or surgical event followed by a characteristic depth change, or a narrative feature that predicts slow emergence.

Rules:
- Only assert a pattern you can point to in at least two cases, and give the case codes. Say how strong it is: "emerging" (2 cases or weak), "moderate", "strong".
- Prefer genuinely new patterns over restating ones already judged.
- Never state a diagnosis and never invent numbers — cite only values present in the data given.
- Be explicit that these are hypotheses from a small, uncontrolled, single-clinician frontal-montage dataset, not evidence.
- British clinical English, concise and specific. Never repeat identifiable detail; if a note contains anything identifying, ignore it and flag it under recordingGaps.

Respond with JSON ONLY, no markdown fences, in this exact shape:
{"headline":string,"perCase":[{"sessionId":string,"caseCode":string,"keyDetails":[string],"riskFactors":[string],"eegCorrelation":string,"citations":[{"sessionId":string,"caseCode":string,"startSeconds":number,"endSeconds":number,"why":string}]}],"patterns":[{"title":string,"detail":string,"strength":"emerging"|"moderate"|"strong","caseCodes":[string],"suggestedAction":string,"citations":[{"sessionId":string,"caseCode":string,"startSeconds":number,"endSeconds":number,"why":string}],"feedbackInfluence":{"direction":"raised"|"lowered"|"unchanged"|"new","strengthWithoutFeedback":"emerging"|"moderate"|"strong"|"not proposed","because":string,"drivers":[string],"relatedTitles":[string]}}],"recordingGaps":[string],"limitations":[string],"feedbackImpact":{"summary":string,"suppressed":[string]}}
At most 4 citations per case and 6 per pattern, at most 8 key details and 5 risk factors per case, at most 6 patterns, at most 4 drivers and 3 relatedTitles per pattern, at most 5 recordingGaps, 4 limitations and 4 suppressed. Keep each string under about 45 words. Order patterns most to least confident after applying the feedback.`;

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

    // Verdicts the clinician has already given, so the AI stops repeating
    // rejected ideas and adopts their rewording of accepted ones.
    const feedback: PatternFeedback[] = [];
    const { data: feedbackRows } = await context.supabase
      .from("case_pattern_feedback")
      .select("pattern_key, verdict, payload_sealed, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(60);
    for (const row of feedbackRows ?? []) {
      let payload: unknown = {};
      if (row.payload_sealed) {
        try {
          payload = JSON.parse(open(row.payload_sealed) ?? "{}");
        } catch {
          payload = {};
        }
      }
      feedback.push(
        normaliseFeedback(
          {
            ...(payload as Record<string, unknown>),
            patternKey: row.pattern_key,
            verdict: row.verdict,
            updatedAt: row.updated_at,
          },
          row.pattern_key,
        ),
      );
    }

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

    const timelines = new Map<string, CaseTimelinePoint[]>();
    if (sessions.length) {
      const { data: eventRows } = await context.supabase
        .from("eeg_events")
        .select("session_id, kind, severity, t_offset_seconds, duration_seconds, detail")
        .eq("user_id", context.userId)
        .in(
          "session_id",
          sessions.map((s) => s.id),
        )
        .order("t_offset_seconds", { ascending: true });
      for (const row of eventRows ?? []) {
        const list = timelines.get(row.session_id) ?? [];
        if (list.length >= 60) continue;
        const start = Math.round(Number(row.t_offset_seconds) || 0);
        list.push({
          kind: row.kind,
          severity: row.severity,
          startSeconds: start,
          endSeconds: start + Math.round(Number(row.duration_seconds) || 0),
          detail: row.detail ?? "",
        });
        timelines.set(row.session_id, list);
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
        eegTimeline: timelines.get(s.id) ?? [],
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
        feedback,
        feedbackImpact: countVerdicts(feedback, "", []),
      };
    }

    const text = await streamGatewayText(
      {
        model: "openai/gpt-5.6-sol",
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  cases,
                  priorClinicianFeedback: feedback.map((f) => ({
                    verdict: f.verdict,
                    title: f.title,
                    detail: f.detail,
                    clinicianNote: f.note,
                    caseCodes: f.caseCodes,
                  })),
                }),
              },
            ],
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
      perCase: (Array.isArray(parsed.perCase) ? parsed.perCase : []).map((c) => ({
        ...c,
        citations: Array.isArray(c?.citations) ? c.citations : [],
      })),
      patterns: (Array.isArray(parsed.patterns) ? parsed.patterns : []).map((p) => ({
        ...p,
        citations: Array.isArray(p?.citations) ? p.citations : [],
        patternKey: patternKey(p?.title ?? ""),
        feedbackInfluence: normaliseInfluence(p?.feedbackInfluence),
      })),
      recordingGaps: Array.isArray(parsed.recordingGaps) ? parsed.recordingGaps : [],
      limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
      generatedAt: new Date().toISOString(),
      feedback,
      feedbackImpact: countVerdicts(
        feedback,
        parsed.feedbackImpact?.summary ?? "",
        Array.isArray(parsed.feedbackImpact?.suppressed)
          ? parsed.feedbackImpact.suppressed.slice(0, 4)
          : [],
      ),
    };
  });
