import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  normaliseFeedback,
  patternKey,
  type PatternFeedback,
} from "@/lib/eeg/pattern-feedback";

/** Every pattern verdict the clinician has recorded so far. */
export const listPatternFeedback = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatternFeedback[]> => {
    const { open } = await import("@/lib/privacy.server");
    const { data, error } = await context.supabase
      .from("case_pattern_feedback")
      .select("pattern_key, verdict, payload_sealed, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    const out: PatternFeedback[] = [];
    for (const row of data ?? []) {
      let payload: unknown = {};
      if (row.payload_sealed) {
        try {
          payload = JSON.parse(open(row.payload_sealed) ?? "{}");
        } catch {
          payload = {};
        }
      }
      out.push(
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
    return out;
  });

/** Record (or update) the clinician's verdict on one proposed pattern. */
export const savePatternFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const fb = normaliseFeedback(input);
    const key = fb.patternKey || patternKey(fb.title);
    if (!key) throw new Error("A pattern needs a title before it can be judged.");
    return { ...fb, patternKey: key };
  })
  .handler(async ({ data, context }) => {
    const { seal } = await import("@/lib/privacy.server");
    const { error } = await context.supabase.from("case_pattern_feedback").upsert(
      {
        user_id: context.userId,
        pattern_key: data.patternKey,
        verdict: data.verdict,
        payload_sealed: seal(JSON.stringify(data)),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,pattern_key" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const, feedback: data };
  });

/** Withdraw a verdict so the pattern is judged fresh next time. */
export const deletePatternFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patternKey: string }) => ({ patternKey: input.patternKey }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("case_pattern_feedback")
      .delete()
      .eq("user_id", context.userId)
      .eq("pattern_key", data.patternKey);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
