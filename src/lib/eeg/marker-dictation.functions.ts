import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AI_MODEL_VERSION } from "@/lib/eeg/interpret.functions";
import { normaliseDictation, type MarkerDictationResult } from "@/lib/eeg/marker-dictation";

const SYSTEM_PROMPT = `You are a theatre assistant turning an anaesthetist's contemporaneous free-text note into timestamped EEG event markers.

You are given the note and the current case clock (elapsed seconds since the recording started).

A single entry usually contains SEVERAL events, often with different times, written in any order and separated by commas, semicolons, "then", "and" or new lines. Split them: produce ONE marker per event, never merge two events into one label, and never drop an event because it shares a sentence with another. Each event keeps its OWN time — do not carry one event's time over to the next.

For every clinical event stated in the note, produce one marker:
- "label": a short, clinically conventional label including drug, dose and route where stated, e.g. "Rocuronium 40 mg IV", "Propofol 100 mg IV", "Surgical incision", "Facial twitching noted". British clinical English, under 60 characters, no full stop.
- For a DRUG administration also fill the structured fields; omit them entirely for non-drug events:
  * "drug": the drug name alone, no dose or route, generic British name ("rocuronium", "co-amoxiclav"). Correct obvious mis-spellings and dictation slips ("roxuronium" → "rocuronium", "sux" → "suxamethonium", "phenyl" → "phenylephrine", "met" → "metaraminol").
  * "doseValue": the number only (40 for "40mg", 0.5 for "500 micrograms" only if the note itself says 0.5 — otherwise keep the number as written with its own unit).
  * "doseUnit": the unit as written, normalised to: mg, mcg, g, ml, units, mmol, mg/kg, mcg/kg, mg/hr, mcg/kg/min, ng/ml. Use "mcg" for micrograms/ug.
  * "route": one of IV, IM, SC, PO, SL, PR, IN, inhaled, nebulised, topical, epidural, intrathecal, infusion, TCI. Expand what was written ("intravenous"/"i.v."/"IV bolus" → IV, "neb" → nebulised, "target controlled infusion" → TCI). If the note does not state a route, omit "route" — do NOT assume IV.
  * Infusions and TCI: "propofol running at 6 mg/kg/hr" → drug "propofol", doseValue 6, doseUnit "mg/kg/hr", route "infusion".
- "atSeconds": whole seconds from the START of the recording.
  * If the note gives a case time ("at 1 minute", "at 12 min", "at 00:45"), convert it to seconds from the start: "at 1 minute" = 60. Mark timing "stated".
  * If the note is relative to now ("2 minutes ago", "just now"), subtract from the elapsed clock. Mark timing "relative".
  * If no time is given, use the elapsed clock and mark timing "assumed-now".
  * Never return a time below 0 or above the elapsed clock.
- "quote": the exact words from the note this marker came from.

Return the markers ordered by "atSeconds", earliest first, regardless of the order they were written in.

Worked example — elapsed clock 600 s, note "rocuronium 40mg IV at 1 minute, incision 2 minutes ago, propofol 100mg at 00:30, fentanyl 100 micrograms, facial twitching now":
[{"label":"Propofol 100 mg","atSeconds":30,"timing":"stated","drug":"propofol","doseValue":100,"doseUnit":"mg","quote":"propofol 100mg at 00:30"},{"label":"Rocuronium 40 mg IV","atSeconds":60,"timing":"stated","drug":"rocuronium","doseValue":40,"doseUnit":"mg","route":"IV","quote":"rocuronium 40mg IV at 1 minute"},{"label":"Surgical incision","atSeconds":480,"timing":"relative","quote":"incision 2 minutes ago"},{"label":"Fentanyl 100 mcg","atSeconds":600,"timing":"assumed-now","drug":"fentanyl","doseValue":100,"doseUnit":"mcg","quote":"fentanyl 100 micrograms"},{"label":"Facial twitching noted","atSeconds":600,"timing":"assumed-now","quote":"facial twitching now"}]

Rules: do not invent events, doses or times not present in the note. Ignore anything that is commentary rather than an event and list it in "unmatched". Never include identifiable patient detail.

Respond with JSON ONLY, no markdown fences, in this exact shape:
{"markers":[{"label":string,"atSeconds":number,"timing":"stated"|"relative"|"assumed-now","quote":string,"drug":string,"doseValue":number,"doseUnit":string,"route":string}],"unmatched":[string]}`;

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