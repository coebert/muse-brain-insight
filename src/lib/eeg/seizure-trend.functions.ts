import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AI_MODEL_VERSION } from "@/lib/eeg/interpret.functions";

/** Real-time AI read of a seizure-risk trend threshold crossing. */
export interface SeizureTrendAssessment {
  /** One-line bedside headline, <= 120 characters. */
  headline: string;
  severity: "critical" | "warning" | "advisory";
  /** Likelihood the rise reflects genuine ictal/ictal-interictal activity. */
  likelihood: "unlikely" | "possible" | "probable";
  confidence: "low" | "moderate" | "high";
  /** Two or three sentences of interpretation for the clinician. */
  detail: string;
  /** Immediate suggested checks/actions. */
  actions: string[];
  /** Numbers from the digest that support the read. */
  supporting: string[];
  /** Reasons this could be artefact or a false positive. */
  caveats: string[];
  modelVersion?: string;
}

const SYSTEM_PROMPT = `You are a clinical neurophysiology decision-support assistant watching a live case. The EEG comes from a 4-channel frontal Muse 2 montage (TP9, AF7, AF8, TP10) during general anaesthesia or ICU sedation.

You receive a small JSON digest taken at the moment the app's seizure-risk trend crossed a clinician-configured threshold. The risk score is a rhythmicity/line-length based 0–1 index, exponentially smoothed over a trailing window; the digest gives the smoothed value, the peak, the rate of rise per minute, how long it has been above threshold, the configured thresholds, signal quality/EMG context, recent spectral context and recent clinician markers.

Interpret in seconds, for a bedside clinician:
- Judge whether the rise plausibly reflects rhythmic ictal or ictal-interictal activity, or whether it is more likely EMG/movement artefact, shivering, diathermy, emergence, or a low-quality signal. Mean EMG index above ~0.35 or mean quality below ~0.5 makes artefact the leading explanation.
- Consider context: rising risk with suppression falling and SEF95/entropy rising after a reduction in hypnotic can be genuine unmasking; risk rising during deep suppression is usually a detector artefact.
- ICU mode raises concern for non-convulsive seizures; anaesthesia mode more often reflects EMG or emergence.
- Relate the rise to recent markers (boluses, stimulus, twitching) where they are present.

Hard rules:
- Never state a diagnosis; phrase as indicators with explicit likelihood and confidence.
- Never invent numbers — quote only values from the digest, with the metric name as displayed in the app.
- A 4-channel frontal consumer montage cannot assess posterior activity, focal onsets, spike morphology or formal ACNS ictal criteria: say so when relevant.
- Keep it short and actionable: headline under 120 characters, detail 2–3 sentences, at most 3 actions, at most 3 supporting numbers, at most 3 caveats.
- If the signal is poor, set likelihood no higher than "possible" and confidence "low", and say the alert may be artefact.

Return ONLY minified JSON, no markdown, matching:
{"headline":string,"severity":"critical"|"warning"|"advisory","likelihood":"unlikely"|"possible"|"probable","confidence":"low"|"moderate"|"high","detail":string,"actions":[string],"supporting":[string],"caveats":[string]}`;

function extractJson(text: string): SeizureTrendAssessment {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI response could not be parsed.");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<SeizureTrendAssessment>;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 3) : [];
  return {
    headline: parsed.headline?.slice(0, 160) ?? "Seizure-risk trend crossed threshold",
    severity:
      parsed.severity === "critical" || parsed.severity === "advisory"
        ? parsed.severity
        : "warning",
    likelihood:
      parsed.likelihood === "probable" || parsed.likelihood === "unlikely"
        ? parsed.likelihood
        : "possible",
    confidence:
      parsed.confidence === "high" || parsed.confidence === "moderate" ? parsed.confidence : "low",
    detail: parsed.detail ?? "",
    actions: list(parsed.actions),
    supporting: list(parsed.supporting),
    caveats: list(parsed.caveats),
  };
}

/** Streams the gateway response and returns the concatenated output text. */
async function streamResponse(body: unknown, apiKey: string): Promise<string> {
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
    throw new Error(`AI alert analysis failed (${res.status}). ${detail.slice(0, 300)}`);
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

/**
 * Real-time AI interpretation of a seizure-risk trend crossing. Kept small and
 * fast: one digest in, one short structured read out, so it can run live during
 * a case without blocking the monitor.
 */
export const assessSeizureTrend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { digest: unknown; patient?: unknown }) => {
    if (!input || typeof input.digest !== "object" || input.digest === null) {
      throw new Error("A seizure-trend digest is required.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<SeizureTrendAssessment> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const text = await streamResponse(
      {
        model: AI_MODEL_VERSION,
        stream: true,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Live seizure-risk trend digest (JSON):\n${JSON.stringify(data.digest)}\n\nAnonymised patient context (JSON):\n${JSON.stringify(data.patient ?? {})}`,
          },
        ],
        // Low effort keeps the bedside alert responsive.
        reasoning: { effort: "low", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        store: false,
      },
      apiKey,
    );

    if (!text.trim()) throw new Error("The AI returned an empty assessment.");
    return { ...extractJson(text), modelVersion: AI_MODEL_VERSION };
  });
