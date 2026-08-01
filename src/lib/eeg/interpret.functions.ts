import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface InterpretationFinding {
  title: string;
  detail: string;
  confidence: "low" | "moderate" | "high";
  supporting: string[];
}

export interface Interpretation {
  headline: string;
  depthOfAnaesthesia: string;
  burstSuppression: string;
  seizureRisk: string;
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
- Use British clinical English, be concise and specific, cite the numbers you rely on.

Respond with JSON ONLY, no markdown fences, in this exact shape:
{"headline":string,"depthOfAnaesthesia":string,"burstSuppression":string,"seizureRisk":string,"pathologyIndicators":[{"title":string,"detail":string,"confidence":"low"|"moderate"|"high","supporting":[string]}],"recommendedChecks":[string],"limitations":[string],"dataQualityCaveat":string}
Keep each string under about 60 words, at most 5 pathology indicators, at most 5 recommended checks and 4 limitations.`;

function extractJson(text: string): Interpretation {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI response could not be parsed.");
  return JSON.parse(cleaned.slice(start, end + 1)) as Interpretation;
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
  .handler(async ({ data }): Promise<Interpretation> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const text = await streamText(
      {
        model: "openai/gpt-5.6-sol",
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
    return extractJson(text);
  });
