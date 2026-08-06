import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AI_MODEL_VERSION } from "@/lib/eeg/interpret.functions";
import { streamGatewayText } from "@/lib/eeg/gateway.server";

export interface BisFinding {
  /** "Agreement", "Bias", "Suppression", "Divergence" or "Model tuning". */
  domain: string;
  detail: string;
  confidence: "low" | "moderate" | "high";
  /** Numbers from the digest that support the reading. */
  supporting: string[];
  tSeconds?: number | null;
}

export interface BisAgreementReport {
  headline: string;
  agreement: string;
  biasReading: string;
  suppressionReading: string;
  divergenceReading: string;
  findings: BisFinding[];
  /** Concrete, cautious suggestions for finessing the open depth model. */
  modelSuggestions: string[];
  limitations: string[];
  modelVersion?: string;
}

const SYSTEM_PROMPT = `You are a clinical measurement-agreement analyst comparing an app's open, non-proprietary depth-of-anaesthesia index (an OpenIBIS-style index computed from a 4-channel frontal Muse 2 montage) against contemporaneous readings a clinician transcribed from a commercial BIS monitor on the same patient.

You receive a JSON digest containing: each paired point (case-clock time, transcribed BIS, transcribed BIS suppression ratio, the app's depth index, the app's suppression ratio, SEF95, whether the app judged the epoch reliable, and its signal-quality score), Bland-Altman style agreement metrics (n, Pearson r, Lin's CCC, bias, SD, 95% limits of agreement, RMSE, MAE, % within 5 and 10 index points, OLS slope/intercept), per-depth-band bias (deep <40, surgical 40-60, light >60), suppression-ratio agreement, the largest divergences, and a least-squares gain/offset that would map the app index onto BIS.

Interpret:
- Agreement: quote r, CCC, bias and the limits of agreement. State plainly whether the app index could substitute for BIS at this sample size (it almost certainly cannot yet).
- Bias direction: positive difference means the app reads LIGHTER than BIS. Say whether bias is uniform or depth-dependent using the per-band figures.
- Suppression: compare suppression ratios directly — these are physiologically defined, so disagreement points to detection thresholds or montage, not to a proprietary scale.
- Divergences: for each large divergence, weigh whether the app flagged the epoch unreliable, whether signal quality was low, EMG was likely, or the value was transcribed at a different instant to the BIS smoothing window (BIS uses a 15-30 s smoothing rate, so transient mismatch is expected).
- Model tuning: suggest cautious, specific adjustments (e.g. applying the fitted gain/offset, revisiting the suppression amplitude floor, weighting a band differently), and say how many more paired points would be needed before trusting them.

Hard rules:
- Never claim to reproduce BIS; it is a proprietary, undisclosed algorithm. Frame everything as agreement, not validation.
- Never invent numbers. Quote only values present in the digest, with units.
- Transcribed values are manual, single-instant readings; treat time alignment as a real source of error.
- With fewer than about 20 paired points, confidence must be low and you must say so.
- Never state a diagnosis or a dosing instruction.

Return ONLY minified JSON, no markdown, matching:
{"headline":string,"agreement":string,"biasReading":string,"suppressionReading":string,"divergenceReading":string,"findings":[{"domain":string,"detail":string,"confidence":"low"|"moderate"|"high","supporting":[string],"tSeconds":number|null}],"modelSuggestions":[string],"limitations":[string]}`;

function extractJson(text: string): BisAgreementReport {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI response could not be parsed.");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as BisAgreementReport;
  return {
    headline: parsed.headline ?? "",
    agreement: parsed.agreement ?? "",
    biasReading: parsed.biasReading ?? "",
    suppressionReading: parsed.suppressionReading ?? "",
    divergenceReading: parsed.divergenceReading ?? "",
    findings: Array.isArray(parsed.findings)
      ? parsed.findings
          .filter((f) => f && typeof f.detail === "string")
          .map((f) => ({
            ...f,
            supporting: Array.isArray(f.supporting) ? f.supporting.slice(0, 4) : [],
          }))
          .slice(0, 8)
      : [],
    modelSuggestions: Array.isArray(parsed.modelSuggestions) ? parsed.modelSuggestions : [],
    limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
  };
}

export const interpretBisAgreement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { digest: unknown; patient?: unknown }) => {
    if (!input || typeof input.digest !== "object" || input.digest === null) {
      throw new Error("A BIS comparison digest is required.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<BisAgreementReport> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const text = await streamGatewayText(
      {
        model: AI_MODEL_VERSION,
        stream: true,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `BIS vs app depth-index comparison digest (JSON):\n${JSON.stringify(data.digest)}\n\nAnonymised patient context (JSON):\n${JSON.stringify(data.patient ?? {})}`,
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
