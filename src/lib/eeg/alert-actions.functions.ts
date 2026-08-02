import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AlertActionKind = "acknowledged" | "escalated" | "resolved";

export const ESCALATION_ROLES = [
  { value: "consultant_anaesthetist", label: "Consultant anaesthetist" },
  { value: "anaesthetic_registrar", label: "Anaesthetic registrar" },
  { value: "icu_consultant", label: "ICU consultant" },
  { value: "icu_registrar", label: "ICU registrar" },
  { value: "neurophysiology", label: "Clinical neurophysiology" },
  { value: "neurology_on_call", label: "Neurology on-call" },
  { value: "outreach_team", label: "Critical care outreach" },
  { value: "bedside_nurse", label: "Bedside nurse in charge" },
] as const;

export interface AlertActionInput {
  alertId: string;
  title: string;
  category: string;
  severity: string;
  action: AlertActionKind;
  note?: string | null;
  escalatedTo?: string | null;
  sessionId?: string | null;
  context?: string | null;
}

export interface AlertActionRow {
  id: string;
  session_id: string | null;
  alert_id: string;
  alert_title: string;
  alert_category: string;
  alert_severity: string;
  action: AlertActionKind;
  note: string | null;
  escalated_to: string | null;
  context: string | null;
  created_at: string;
}

const ACTIONS: AlertActionKind[] = ["acknowledged", "escalated", "resolved"];
const ROLE_VALUES = ESCALATION_ROLES.map((r) => r.value as string);

export const recordAlertAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: AlertActionInput) => {
    if (!input || typeof input.alertId !== "string" || !input.alertId.trim()) {
      throw new Error("An alert id is required.");
    }
    if (!ACTIONS.includes(input.action)) throw new Error("Invalid action.");
    const escalatedTo = input.escalatedTo ?? null;
    if (input.action === "escalated" && (!escalatedTo || !ROLE_VALUES.includes(escalatedTo))) {
      throw new Error("Choose a clinician role to escalate to.");
    }
    const note = (input.note ?? "").toString().trim().slice(0, 1000);
    return { ...input, note: note || null, escalatedTo };
  })
  .handler(async ({ data, context }): Promise<AlertActionRow> => {
    const { data: row, error } = await context.supabase
      .from("ai_alert_actions")
      .insert({
        user_id: context.userId,
        session_id: data.sessionId ?? null,
        alert_id: data.alertId.slice(0, 120),
        alert_title: (data.title || "").slice(0, 200),
        alert_category: (data.category || "other").slice(0, 60),
        alert_severity: (data.severity || "advisory").slice(0, 30),
        action: data.action,
        note: data.note,
        escalated_to: data.escalatedTo,
        context: data.context ?? null,
      })
      .select(
        "id, session_id, alert_id, alert_title, alert_category, alert_severity, action, note, escalated_to, context, created_at",
      )
      .single();
    if (error) throw new Error(error.message);
    return row as AlertActionRow;
  });

export const listAlertActions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sessionId?: string | null } | undefined) => input ?? {})
  .handler(async ({ data, context }): Promise<AlertActionRow[]> => {
    let q = context.supabase
      .from("ai_alert_actions")
      .select(
        "id, session_id, alert_id, alert_title, alert_category, alert_severity, action, note, escalated_to, context, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (data.sessionId) q = q.eq("session_id", data.sessionId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []) as AlertActionRow[];
  });