import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface InterpretationFinding {
  title: string;
  detail: string;
  confidence: "low" | "moderate" | "high";
  supporting: string[];
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
}

const SYSTEM_PROMPT = `You are a clinical neurophysiology decision-support assistant reviewing quantitative EEG derived from a 4-channel consumer Muse 2 headband (frontal/temporal electrodes: TP9, AF7, AF8, TP10) used during general anaesthesia or ICU sedation.

You receive a numeric digest of one monitoring session plus anonymised demographics and admission details. Reason like a neurophysiologist:
- Depth of anaesthesia/sedation: interpret SEF95, the BIS-like depthIndex (an uncalibrated OpenIBIS-style index from this frontal montage — use as a trend, cross-check against SEF95 and suppression, and say so if they disagree), relative band powers (frontal alpha spindles vs delta dominance), total power, and their trend across the session.
- Burst suppression: interpret suppression ratio, longest suppression run and isoelectric events against age (elderly and frail patients suppress at lower doses) and clinical features.
- Seizure/ictal risk: interpret rhythmicity-based seizure score, alert count, and the fraction of time above threshold, especially in ICU/hypoxic-brain-injury contexts (non-convulsive status epilepticus).
- Possible cerebral pathology indicators visible to a frontal montage: generalised slowing (encephalopathy, sepsis-associated or delirium), focal/asymmetric slowing, loss of frontal alpha, attenuation/low voltage (hypoxic-ischaemic injury after OOHCA), highly suppressed or discontinuous background, periodic patterns and rhythmic ictal-interictal patterns. Only raise these where the numbers support them.

Hard constraints:
- Never state a diagnosis. Phrase findings as indicators, patterns, and their differential, with an explicit confidence level.
- Explicitly acknowledge what a 4-channel frontal consumer montage CANNOT assess (posterior/occipital activity, most focal onsets, spike morphology, formal ACNS ictal-interictal criteria, asymmetry beyond frontotemporal).
- Weigh data quality: if usable fraction is low or the session is short (<5 minutes), degrade confidence and say so.
- Depth-index reliability gating: depthIndex.reliableFraction is the share of epochs where the index passed real-time artefact/EMG gating, depthIndex.meanConfidence is its mean 0–1 confidence, depthIndex.meanWhenReliable/latestReliable are computed from clean epochs only, and depthIndex.topGatingReasons lists why it was gated. Prefer the reliable-only values, state the reliable fraction whenever it is below 0.8, and if reliableFraction < 0.5 or latestIsReliable is false, treat the depth index as unreliable: lean on SEF95, entropy and suppression instead and say the depth index could not be trusted.

Marker cross-referencing (important):
- markerResponses gives, for each clinician marker (e.g. "Ketamine bolus", "Facial twitching noted"), the mean of each index in the 60 s before and 120 s after, the change, and any automatically detected events that followed within that window. markerPhases gives the session segmented by marker, with mean indices per phase. detectedEvents lists automatic suppression/seizure/trend events.
- Use these to judge whether the EEG responded as expected to each intervention (e.g. ketamine typically raises beta/EMG-like high-frequency power and the depth index; propofol/volatile deepening lowers SEF95, entropy and depth index and may bring on suppression; neuromuscular blockade removes EMG contamination and can drop an EMG-inflated depth index without any true change in depth; a marked twitch or stimulus with a rising nociception index suggests inadequate analgesia).
- Flag non-responses and paradoxical responses explicitly, and say when a change is more likely artefactual (EMG loss after relaxant) than a true depth change.

Alerting:
- Populate "alerts" with the actionable problems you can defend from the numbers, most urgent first (at most 5, and only real ones — return [] if nothing is actionable).
- severity: "critical" for immediate patient-safety issues (sustained deep suppression/isoelectric background, probable ongoing ictal activity, suspected awareness during paralysis), "warning" for developing problems, "advisory" for things to watch.
- category must be one of excessive_depth, inadequate_depth, burst_suppression, seizure, hypoxic_injury, encephalopathy, nociception, signal_quality, other.
- id: a short lowercase stable slug for the problem (e.g. "deep-suppression", "ictal-risk", "low-voltage-hie") so repeat analyses of the same problem reuse the same id.
- action: one concrete clinical next step (e.g. "Reduce propofol infusion and re-check suppression ratio in 5 min", "Consider urgent formal EEG for non-convulsive status").
- tSeconds: session time the problem is anchored to, or null.
- Never alert purely on poor signal quality unless quality is the problem — use category signal_quality then.

Clinician feedback (learning loop):
- You may be given "clinicianFeedback": past alerts this clinician marked correct or incorrect, with their stated reason. Treat it as calibration for this user and setting.
- Where an alert id/category was repeatedly marked incorrect for a stated reason, raise your evidential bar for that alert: only re-raise it if the numbers clearly overcome the objection, and address the objection in the detail text.
- Where an alert was marked correct, keep raising it under similar conditions and reuse the same id.
- Never mention the feedback mechanism itself in your output.
- Use British clinical English, be concise and specific, cite the numbers you rely on.

Respond with JSON ONLY, no markdown fences, in this exact shape:
{"headline":string,"alerts":[{"id":string,"severity":"critical"|"warning"|"advisory","category":string,"title":string,"detail":string,"action":string,"confidence":"low"|"moderate"|"high","tSeconds":number|null}],"depthOfAnaesthesia":string,"burstSuppression":string,"seizureRisk":string,"markerCorrelations":[string],"pathologyIndicators":[{"title":string,"detail":string,"confidence":"low"|"moderate"|"high","supporting":[string]}],"recommendedChecks":[string],"limitations":[string],"dataQualityCaveat":string}
Keep each string under about 60 words, at most 5 alerts, at most 6 markerCorrelations (one per notable marker, naming the marker), at most 5 pathology indicators, at most 5 recommended checks and 4 limitations.`;

function extractJson(text: string): Interpretation {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI response could not be parsed.");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Interpretation;
  return {
    ...parsed,
    alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    markerCorrelations: Array.isArray(parsed.markerCorrelations) ? parsed.markerCorrelations : [],
    pathologyIndicators: Array.isArray(parsed.pathologyIndicators) ? parsed.pathologyIndicators : [],
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
  .inputValidator((input: { digest: unknown }) => {
    if (!input || typeof input.digest !== "object" || input.digest === null) {
      throw new Error("A session digest is required.");
    }
    return input;
  })
  .handler(async ({ data, context }): Promise<Interpretation> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const { data: feedback } = await context.supabase
      .from("ai_alert_feedback")
      .select("alert_id, alert_category, alert_severity, alert_title, verdict, reason, created_at")
      .order("created_at", { ascending: false })
      .limit(40);

    const text = await streamText(
      {
        model: "openai/gpt-5.6-sol",
        stream: true,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Quantitative session digest (JSON):\n${JSON.stringify(data.digest)}\n\nclinicianFeedback (JSON, most recent first):\n${JSON.stringify(feedback ?? [])}`,
          },
        ],
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        store: false,
      },
      apiKey,
    );

    if (!text.trim()) throw new Error("The AI returned an empty analysis. Please try again.");
    return extractJson(text);
  });
