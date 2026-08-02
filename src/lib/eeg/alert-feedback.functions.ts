import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AlertVerdict = "correct" | "incorrect" | "unsure";

export interface AlertFeedbackInput {
  alertId: string;
  category: string;
  severity: string;
  title: string;
  verdict: AlertVerdict;
  reason?: string | null;
  sessionId?: string | null;
  context?: string | null;
}

export interface AlertFeedbackRow {
  id: string;
  alert_id: string;
  alert_category: string;
  alert_severity: string;
  alert_title: string;
  verdict: AlertVerdict;
  reason: string | null;
  context: string | null;
  created_at: string;
}

const VERDICTS: AlertVerdict[] = ["correct", "incorrect", "unsure"];

export const submitAlertFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: AlertFeedbackInput) => {
    if (!input || typeof input.alertId !== "string" || !input.alertId.trim()) {
      throw new Error("An alert id is required.");
    }
    if (!VERDICTS.includes(input.verdict)) throw new Error("Invalid verdict.");
    const reason = (input.reason ?? "").toString().trim().slice(0, 1000);
    return { ...input, reason: reason || null };
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("ai_alert_feedback").insert({
      user_id: context.userId,
      session_id: data.sessionId ?? null,
      alert_id: data.alertId.slice(0, 120),
      alert_category: (data.category || "other").slice(0, 60),
      alert_severity: (data.severity || "advisory").slice(0, 30),
      alert_title: (data.title || "").slice(0, 200),
      verdict: data.verdict,
      reason: data.reason,
      context: data.context ?? null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listAlertFeedback = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AlertFeedbackRow[]> => {
    const { data, error } = await context.supabase
      .from("ai_alert_feedback")
      .select("id, alert_id, alert_category, alert_severity, alert_title, verdict, reason, context, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as AlertFeedbackRow[];
  });