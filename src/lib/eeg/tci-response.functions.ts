import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AI_MODEL_VERSION } from "@/lib/eeg/interpret.functions";

export interface TciFinding {
  /** Pump/drug the finding is about, e.g. "Eleveld propofol". */
  drug: string;
  /** "Spectral", "Burst suppression", "Seizure risk" or "Nociception". */
  domain: string;
  /** Direction of the observed dose effect. */
  effect: "expected" | "exaggerated" | "blunted" | "paradoxical" | "none";
  detail: string;
  confidence: "low" | "moderate" | "high";
  /** Numbers from the digest that support the reading. */
  supporting: string[];
  tSeconds?: number | null;
}

export interface TciResponseReport {
  headline: string;
  spectralResponse: string;
  suppressionResponse: string;
  seizureResponse: string;
  findings: TciFinding[];
  titrationSuggestions: string[];
  limitations: string[];
  modelVersion?: string;
}

const SYSTEM_PROMPT = `You are a clinical decision-support assistant for anaesthesia and ICU sedation, reviewing how target-controlled infusion (TCI) changes relate to processed EEG from a 4-channel frontal Muse 2 montage (TP9, AF7, AF8, TP10).

You receive a JSON digest containing: the pumps running (Eleveld propofol, propofol+alfentanil, propofol+ketamine, remifentanil), every effect-site target (Ce) change with the mean of each index in the 90 s before and 240 s after, automatically detected events that followed, and a whole-infusion dose-response (Pearson r between held Ce and each index, plus mean indices at each target held).

Interpret, for each drug:
- Spectral response: propofol deepening should lower SEF95 and state entropy, raise the delta/alpha ratio and lower the depth index; frontal alpha should appear at surgical targets. Remifentanil and alfentanil alone move the hypnotic indices little — a large hypnotic change on an opioid-only change is more likely stimulus-related or artefactual. Ketamine typically raises high-frequency power, SEF95 and the depth index without lightening the patient — say so explicitly rather than calling it inadequate depth.
- Burst suppression: relate rising suppression ratio and new suppression events to propofol target increases, and to age/frailty when supplied. Flag suppression appearing at modest targets as excess sensitivity.
- Seizure risk: relate seizure score and ictal-appearing events to dose changes; note that abrupt reductions can unmask ictal activity in ICU patients, and that suppression can mask it.
- Nociception: relate qNOX/nociception movement to opioid target changes and stimulus markers.

Hard rules:
- Never state a diagnosis and never claim a pharmacokinetic prediction — the pump owns the model, you interpret only the recorded targets against the EEG.
- Never invent numbers. Quote only values present in the digest, with units and the metric name as displayed in the app.
- effect must be one of expected, exaggerated, blunted, paradoxical, none. Say "none" when the index did not move.
- Correlation is not causation: with few target changes, short windows, surgical stimulation and concurrent drugs, say confidence is low.
- Acknowledge that a frontal consumer montage cannot assess posterior activity, focal onsets or formal ictal criteria.
- If the digest is sparse (few or no Ce changes, little EEG), say so plainly and return few findings.

Return ONLY minified JSON, no markdown, matching:
{"headline":string,"spectralResponse":string,"suppressionResponse":string,"seizureResponse":string,"findings":[{"drug":string,"domain":string,"effect":"expected"|"exaggerated"|"blunted"|"paradoxical"|"none","detail":string,"confidence":"low"|"moderate"|"high","supporting":[string],"tSeconds":number|null}],"titrationSuggestions":[string],"limitations":[string]}`;

function extractJson(text: string): TciResponseReport {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI response could not be parsed.");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as TciResponseReport;
  return {
    headline: parsed.headline ?? "",
    spectralResponse: parsed.spectralResponse ?? "",
    suppressionResponse: parsed.suppressionResponse ?? "",
    seizureResponse: parsed.seizureResponse ?? "",
    findings: Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f) => f && typeof f.detail === "string")
          .map((f) => ({
            ...f,
            supporting: Array.isArray(f.supporting) ? f.supporting.slice(0, 4) : [],
          }))
          .slice(0, 8)
      : [],
    titrationSuggestions: Array.isArray(parsed.titrationSuggestions)
      ? parsed.titrationSuggestions
      : [],
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

export const interpretTciResponse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { digest: unknown; patient?: unknown }) => {
    if (!input || typeof input.digest !== "object" || input.digest === null) {
      throw new Error("A TCI response digest is required.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<TciResponseReport> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const text = await streamText(
      {
        model: AI_MODEL_VERSION,
        stream: true,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `TCI dose–response digest (JSON):\n${JSON.stringify(data.digest)}\n\nAnonymised patient context (JSON):\n${JSON.stringify(data.patient ?? {})}`,
          },
        ],
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        store: false,
      },
      apiKey,
    );

    if (!text.trim()) throw new Error("The AI returned an empty analysis. Please try again.");
    return { ...extractJson(text), modelVersion: AI_MODEL_VERSION };
  });
