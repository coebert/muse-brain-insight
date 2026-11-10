import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AlertTuning, AlertTuningEffect, TuningFeedbackRow } from "@/lib/eeg/alert-tuning";
import { guardInterpretation, type GuardReport } from "@/lib/eeg/interpret-guard";

export interface InterpretationFinding {
  title: string;
  detail: string;
  confidence: "low" | "moderate" | "high";
  supporting: string[];
}

/** AI model backing the alert reviewer — recorded with clinician feedback. */
export const AI_MODEL_VERSION = "openai/gpt-5.6-sol";

export interface AlertEvidence {
  /** Metric name as displayed in the app, e.g. "Suppression ratio". */
  feature: string;
  /** Observed value with units, e.g. "38 %". */
  value: string;
  /** Threshold or typical range compared against. */
  expected?: string | null;
  direction: "high" | "low" | "rising" | "falling" | "unstable" | "normal";
  /** Relative contribution to the alert, 0–1. */
  weight: number;
  /** Session time window (seconds) the value was measured over. */
  windowStartSeconds?: number | null;
  windowEndSeconds?: number | null;
  note?: string | null;
}

export interface AlertFeedbackInfluence {
  /** How past clinician feedback changed this alert compared with an unmoderated read. */
  adjustment: "raised_bar" | "reinforced" | "reworded" | "downgraded" | "none";
  /** One sentence on what changed in the interpretation because of that feedback. */
  note: string;
}

export interface AlertPriorFeedback {
  correct: number;
  incorrect: number;
  /** Most recent reasons the clinician gave when marking this alert incorrect. */
  reasons: string[];
  lastVerdictAt?: string | null;
}

export interface ClinicalAlert {
  /** Stable-ish key so repeat analyses don't re-alert for the same problem. */
  id: string;
  severity: "critical" | "warning" | "advisory";
  category:
    | "excessive_depth"
    | "inadequate_depth"
    | "burst_suppression"
    | "seizure"
    | "hypoxic_injury"
    | "encephalopathy"
    | "nociception"
    | "signal_quality"
    | "other";
  title: string;
  detail: string;
  action: string;
  confidence: "low" | "moderate" | "high";
  tSeconds?: number | null;
  /** Top contributing features/metrics that triggered this alert. */
  evidence?: AlertEvidence[];
  /** How prior clinician feedback shaped this alert (model-reported). */
  feedbackInfluence?: AlertFeedbackInfluence | null;
  /** Factual counts of past clinician verdicts for this alert id/category. */
  priorFeedback?: AlertPriorFeedback | null;
  /** How adaptive tuning changed this alert's severity/confidence. */
  tuning?: AlertTuningEffect | null;
}

export interface Interpretation {
  headline: string;
  alerts: ClinicalAlert[];
  depthOfAnaesthesia: string;
  burstSuppression: string;
  seizureRisk: string;
  markerCorrelations: string[];
  pathologyIndicators: InterpretationFinding[];
  recommendedChecks: string[];
  limitations: string[];
  dataQualityCaveat: string;
  /** Model that produced this interpretation. */
  modelVersion?: string;
  /**
   * Retired: clinician feedback no longer tunes alerts. Kept on the type so
   * stored interpretations still load; always null/0 for new reviews.
   */
  alertTuning?: AlertTuning | null;
  suppressedByTuning?: number;
  /** What the server-side output restrictions removed from this review. */
  guard?: GuardReport | null;
  /** The reviewer explains supplied metrics; it does not decide treatment. */
  role?: "explanatory";
}

const SYSTEM_PROMPT = `You are a clinical neurophysiology decision-support assistant reviewing quantitative EEG derived from a 4-channel consumer Muse 2 headband (frontal/temporal electrodes: TP9, AF7, AF8, TP10) used during general anaesthesia or ICU sedation.

You receive a numeric digest of one monitoring session plus anonymised demographics and admission details. Reason like a neurophysiologist:
- Depth of anaesthesia/sedation: interpret SEF95, the BIS-like depthIndex (an uncalibrated OpenIBIS-style index from this frontal montage — use as a trend, cross-check against SEF95 and suppression, and say so if they disagree), relative band powers (frontal alpha spindles vs delta dominance), total power, and their trend across the session.
- Burst suppression: interpret suppression ratio, longest suppression run and isoelectric events against age (elderly and frail patients suppress at lower doses) and clinical features.
- Seizure/ictal risk: interpret rhythmicity-based seizure score, alert count, and the fraction of time above threshold, especially in ICU/hypoxic-brain-injury contexts (non-convulsive status epilepticus).
- Possible cerebral pathology indicators visible to a frontal montage: generalised slowing (encephalopathy, sepsis-associated or delirium), focal/asymmetric slowing, loss of frontal alpha, attenuation/low voltage (hypoxic-ischaemic injury after OOHCA), highly suppressed or discontinuous background, periodic patterns and rhythmic ictal-interictal patterns. Only raise these where the numbers support them.

Your role (hard constraints, also enforced on your output by the server):
- You EXPLAIN the supplied, already-computed metrics. You do not analyse raw EEG, and you are not a treatment decision maker.
- Never recommend starting, stopping, increasing, reducing or titrating any drug, infusion, dose, vapour or target. Any treatment change is the clinician's decision.
- Never assert or suspect awareness or recall: EEG from this montage cannot establish them. You may state this as a limitation.
- Every number you cite must appear in the digest. If a value is null or marked unavailable/withheld (e.g. suppression.available is false), say it is unavailable — never treat it as zero and never estimate it.
- The depth index is a research index graded for agreement with BIS on surgical cases; it is not a validated measure of consciousness or responsiveness.
- Never state a diagnosis. Phrase findings as indicators, patterns, and their differential, with an explicit confidence level.
- Explicitly acknowledge what a 4-channel frontal consumer montage CANNOT assess (posterior/occipital activity, most focal onsets, spike morphology, formal ACNS ictal-interictal criteria, asymmetry beyond frontotemporal).
- Weigh data quality: if usable fraction is low or the session is short (<5 minutes), degrade confidence and say so.
- Depth-index reliability gating: every depth aggregate supplied (meanWhenReliable, minWhenReliable, maxWhenReliable, fractionBelow40WhenReliable, latestReliable) is computed from reliability-gated epochs only — ungated aggregates are deliberately not provided, so never infer or reconstruct them. depthIndex.reliableFraction is the share of epochs that passed real-time artefact/EMG gating, depthIndex.gatedEpochs how many were discarded, depthIndex.meanConfidence its mean 0–1 confidence, and depthIndex.topGatingReasons why it was gated. State the reliable fraction whenever it is below 0.8, and if reliableFraction < 0.5 or latestIsReliable is false, treat the depth index as unreliable: lean on SEF95, entropy and suppression instead and say the depth index could not be trusted.

Marker cross-referencing (important):
- patient.caseSummary is the clinician's own free-text account of the case. Read it for context the numbers cannot give (frailty, urgency, surgical events, drug history, prior brain injury, recovery behaviour). Use it to weight your findings and, where it explains a numeric pattern, say so in plain terms. Never treat it as a substitute for the numbers and never repeat identifiable detail.
- markerResponses gives, for each clinician marker (e.g. "Ketamine bolus", "Facial twitching noted"), the mean of each index in the 60 s before and 120 s after, the change, and any automatically detected events that followed within that window. markerPhases gives the session segmented by marker, with mean indices per phase. detectedEvents lists automatic suppression/seizure/trend events.
- Use these to judge whether the EEG responded as expected to each intervention (e.g. ketamine typically raises beta/EMG-like high-frequency power and the depth index; propofol/volatile deepening lowers SEF95, entropy and depth index and may bring on suppression; neuromuscular blockade removes EMG contamination and can drop an EMG-inflated depth index without any true change in depth; a marked twitch or stimulus with a rising nociception index suggests inadequate analgesia).
- Flag non-responses and paradoxical responses explicitly, and say when a change is more likely artefactual (EMG loss after relaxant) than a true depth change.

Alerting:
- Populate "alerts" with the actionable problems you can defend from the numbers, most urgent first (at most 5, and only real ones — return [] if nothing is actionable).
- severity: "warning" for patterns that merit prompt clinician review, "advisory" for things to watch. Do not use "critical": deterministic research alarms are computed separately by the app.
- category must be one of excessive_depth, inadequate_depth, burst_suppression, seizure, hypoxic_injury, encephalopathy, nociception, signal_quality, other.
- id: a short lowercase stable slug for the problem (e.g. "deep-suppression", "ictal-risk", "low-voltage-hie") so repeat analyses of the same problem reuse the same id.
- action: one review or monitoring step, never a drug change (e.g. "Re-check electrode contact and the suppression trend over the next 5 min", "Consider formal multichannel EEG review").
- tSeconds: session time the problem is anchored to, or null.
- Never alert purely on poor signal quality unless quality is the problem — use category signal_quality then.

Explainability (required for every alert):
- Each alert MUST include "evidence": the 2–4 top contributing features/metrics that actually triggered it, most influential first.
- feature: metric name as displayed in the app (e.g. "Suppression ratio", "SEF95", "Depth index", "Seizure score", "State entropy", "Delta/alpha ratio", "Beta/alpha ratio", "Total power", "qCON", "qNOX", "Usable fraction", or a named marker response).
- value: the observed number with units, taken from the digest — never invent numbers. expected: the threshold or typical range you compare against, or null.
- direction: one of high, low, rising, falling, unstable, normal.
- weight: your 0–1 estimate of how much that feature drove the alert (they need not sum to 1).
- windowStartSeconds/windowEndSeconds: the session time window in seconds from session start that the value covers; use the window of the digest field you cite, or null for whole-session values.
- note: at most 15 words on why that feature supports the alert.
- Always include signal-quality context in the evidence when it affected the alert: cite "Usable fraction", "Depth index reliability" or "Top gating reason" as an evidence item with direction low/unstable, so the clinician can see how trustworthy the driving numbers were.

Style:
- Use British clinical English, be concise and specific, cite the numbers you rely on.

Respond with JSON ONLY, no markdown fences, in this exact shape:
{"headline":string,"alerts":[{"id":string,"severity":"warning"|"advisory","category":string,"title":string,"detail":string,"action":string,"confidence":"low"|"moderate"|"high","tSeconds":number|null,"evidence":[{"feature":string,"value":string,"expected":string|null,"direction":"high"|"low"|"rising"|"falling"|"unstable"|"normal","weight":number,"windowStartSeconds":number|null,"windowEndSeconds":number|null,"note":string}]}],"depthOfAnaesthesia":string,"burstSuppression":string,"seizureRisk":string,"markerCorrelations":[string],"pathologyIndicators":[{"title":string,"detail":string,"confidence":"low"|"moderate"|"high","supporting":[string]}],"recommendedChecks":[string],"limitations":[string],"dataQualityCaveat":string}
Keep each string under about 60 words, at most 5 alerts, at most 6 markerCorrelations (one per notable marker, naming the marker), at most 5 pathology indicators, at most 5 recommended checks and 4 limitations.`;

const INFLUENCE_VALUES = new Set(["raised_bar", "reinforced", "reworded", "downgraded", "none"]);

type FeedbackRow = TuningFeedbackRow;

/** Factual prior-verdict counts for an alert, matched on id first then category. */
function priorFeedbackFor(alert: ClinicalAlert, rows: FeedbackRow[]): AlertPriorFeedback | null {
  const byId = rows.filter((r) => r.alert_id && r.alert_id === alert.id);
  const matched = byId.length ? byId : rows.filter((r) => r.alert_category === alert.category);
  if (!matched.length) return null;
  const correct = matched.filter((r) => r.verdict === "correct").length;
  const incorrect = matched.filter((r) => r.verdict === "incorrect").length;
  const reasons = matched
    .filter((r) => r.verdict === "incorrect" && r.reason)
    .map((r) => r.reason as string)
    .slice(0, 3);
  return { correct, incorrect, reasons, lastVerdictAt: matched[0]?.created_at ?? null };
}

function extractJson(text: string): Interpretation {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI response could not be parsed.");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Interpretation;
  const alerts = Array.isArray(parsed.alerts) ? parsed.alerts : [];
  return {
    ...parsed,
    alerts: alerts.map((a) => ({
      ...a,
      feedbackInfluence:
        a?.feedbackInfluence &&
        typeof a.feedbackInfluence.note === "string" &&
        INFLUENCE_VALUES.has(a.feedbackInfluence.adjustment)
          ? a.feedbackInfluence
          : null,
      evidence: Array.isArray(a?.evidence)
        ? a.evidence
            .filter((e) => e && typeof e.feature === "string")
            .map((e) => ({
              ...e,
              weight:
                typeof e.weight === "number" && isFinite(e.weight)
                  ? Math.max(0, Math.min(1, e.weight))
                  : 0.5,
            }))
            .sort((x, y) => y.weight - x.weight)
            .slice(0, 4)
        : [],
    })),
    markerCorrelations: Array.isArray(parsed.markerCorrelations) ? parsed.markerCorrelations : [],
    pathologyIndicators: Array.isArray(parsed.pathologyIndicators)
      ? parsed.pathologyIndicators
      : [],
    recommendedChecks: Array.isArray(parsed.recommendedChecks) ? parsed.recommendedChecks : [],
    limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
  };
}

/** Streams the gateway response and returns the concatenated output text. */
async function streamText(body: unknown, apiKey: string): Promise<string> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify(body),
    // A hung gateway must not hold the bedside request open indefinitely.
    signal: AbortSignal.timeout(90_000),
  });

  if (res.status === 429) throw new Error("AI rate limit reached — please try again shortly.");
  if (res.status === 402)
    throw new Error("AI credits exhausted. Add credits in Settings → Plans & credits.");
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI analysis failed (${res.status}). ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload) as {
          type?: string;
          delta?: string;
          response?: { output_text?: string };
        };
        if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
          text += evt.delta;
        } else if (evt.type === "response.completed" && evt.response?.output_text && !text) {
          text = evt.response.output_text;
        }
      } catch {
        // ignore keep-alive / non-JSON frames
      }
    }
  }
  return text;
}

export const interpretSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { digest: unknown; sessionId?: string | null }) => {
    if (!input || typeof input.digest !== "object" || input.digest === null) {
      throw new Error("A session digest is required.");
    }
    return input;
  })
  .handler(async ({ data, context }): Promise<Interpretation> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    // Feedback is stored for offline review only. It is NOT sent to the model
    // and does not tune alerts; the counts are attached as plain history.
    const { data: feedback } = await context.supabase
      .from("ai_alert_feedback")
      .select(
        "alert_id, alert_category, alert_severity, alert_title, verdict, reason, created_at, session_id",
      )
      .order("created_at", { ascending: false })
      .limit(40);
    const rows = (feedback ?? []) as FeedbackRow[];

    const text = await streamText(
      {
        model: AI_MODEL_VERSION,
        stream: true,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Quantitative session digest (JSON):\n${JSON.stringify(data.digest)}`,
          },
        ],
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        store: false,
      },
      apiKey,
    );

    if (!text.trim()) throw new Error("The AI returned an empty analysis. Please try again.");
    const parsed = extractJson(text);
    // Enforce the output restrictions server-side; the prompt alone is not trusted.
    const { output, report } = guardInterpretation(parsed, data.digest);
    return {
      ...output,
      alerts: output.alerts.map((a) => ({ ...a, priorFeedback: priorFeedbackFor(a, rows) })),
      alertTuning: null,
      suppressedByTuning: 0,
      guard: report,
      role: "explanatory",
      modelVersion: AI_MODEL_VERSION,
    };
  });
