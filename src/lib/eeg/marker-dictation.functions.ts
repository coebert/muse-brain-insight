import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AI_MODEL_VERSION } from "@/lib/eeg/interpret.functions";
import { normaliseDictation, type MarkerDictationResult } from "@/lib/eeg/marker-dictation";

const SYSTEM_PROMPT = `You are a theatre assistant turning an anaesthetist's contemporaneous free-text note into timestamped EEG event markers.

You are given the note and the current case clock (elapsed seconds since the recording started).

For every clinical event stated in the note, produce one marker:
- "label": a short, clinically conventional label including drug and dose where stated, e.g. "Rocuronium 40 mg", "Propofol 100 mg bolus", "Surgical incision", "Facial twitching noted". British clinical English, under 60 characters, no full stop.
- "atSeconds": whole seconds from the START of the recording.
  * If the note gives a case time ("at 1 minute", "at 12 min", "at 00:45"), convert it to seconds from the start: "at 1 minute" = 60. Mark timing "stated".
  * If the note is relative to now ("2 minutes ago", "just now"), subtract from the elapsed clock. Mark timing "relative".
  * If no time is given, use the elapsed clock and mark timing "assumed-now".
  * Never return a time below 0 or above the elapsed clock.
- "quote": the exact words from the note this marker came from.

Rules: one marker per event, split multiple events in one sentence into separate markers. Do not invent events, doses or times not present in the note. Ignore anything that is commentary rather than an event and list it in "unmatched". Never include identifiable patient detail.

Respond with JSON ONLY, no markdown fences, in this exact shape:
{"markers":[{"label":string,"atSeconds":number,"timing":"stated"|"relative"|"assumed-now","quote":string}],"unmatched":[string]}`;

/**
 * Read a clinician's mid-case free text and propose markers with timestamps.
 * Nothing is filed here: the clinician confirms the proposals at the bedside.
 */
export const parseMarkerDictation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { text: string; elapsed: number }) => {
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!text) throw new Error("Type something for the AI to read.");
    if (text.length > 2000) throw new Error("That note is too long — keep it under 2000 characters.");
    const elapsed = Number(input?.elapsed);
    return { text, elapsed: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0 };
  })
  .handler(async ({ data }): Promise<MarkerDictationResult> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const { streamGatewayText, parseJsonObject } = await import("@/lib/eeg/case-notes.server");

    const text = await streamGatewayText(
      {
        model: AI_MODEL_VERSION,
        stream: true,
        reasoning: { effort: "none" },
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Elapsed case clock: ${Math.round(data.elapsed)} seconds.\n\nNote:\n${data.text}`,
          },
        ],
        store: false,
      },
      apiKey,
    );

    if (!text.trim()) throw new Error("The AI returned nothing — please try again.");
    return normaliseDictation(parseJsonObject<unknown>(text), data.elapsed);
  });