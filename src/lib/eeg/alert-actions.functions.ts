import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AlertEvidence } from "@/lib/eeg/interpret.functions";
import {
  ALERT_ACTION_COLUMNS,
  toAlertActionRow,
  type AlertActionKind,
  type AlertActionRow,
  type OverrideStance,
} from "@/lib/eeg/alert-action-row";

export type { AlertActionKind, AlertActionRow, OverrideStance };

export const OVERRIDE_STANCES = [
  {
    value: "agree",
    label: "Agree with the AI read",
    hint: "Evidence supports the alert; acting on it.",
  },
  {
    value: "partial",
    label: "Partly agree",
    hint: "Signal is real but the interpretation or severity is off.",
  },
  {
    value: "override",
    label: "Override — clinical picture differs",
    hint: "Overruling the alert on clinical grounds.",
  },
  {
    value: "defer",
    label: "Defer — need more data",
    hint: "Holding action pending more EEG or clinical information.",
  },
] as const;

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
  /** Clinician stance on the AI's interpretation. */
  overrideStance?: OverrideStance | null;
  /** Free-text rationale captured at acknowledge/escalate time. */
  overrideRationale?: string | null;
  /** Evidence feature names the clinician explicitly cited. */
  citedFeatures?: string[] | null;
  /** Stated confidence of the alert being actioned. */
  alertConfidence?: string | null;
  /** Snapshot of the evidence shown when the action was taken. */
  evidenceSnapshot?: AlertEvidence[] | null;
}

const ACTIONS: AlertActionKind[] = ["acknowledged", "escalated", "resolved"];
const ROLE_VALUES = ESCALATION_ROLES.map((r) => r.value as string);
const STANCE_VALUES = OVERRIDE_STANCES.map((s) => s.value as string);
const SELECT_COLS = ALERT_ACTION_COLUMNS;

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
    const stance = (input.overrideStance ?? "agree") as OverrideStance;
    if (!STANCE_VALUES.includes(stance)) throw new Error("Invalid override stance.");
    const rationale = (input.overrideRationale ?? "").toString().trim().slice(0, 2000);
    if (stance !== "agree" && input.action !== "resolved" && !rationale) {
      throw new Error("Add a short rationale when you differ from the AI read.");
    }
    const cited = Array.from(
      new Set(
        (input.citedFeatures ?? []).map((f) => String(f).trim().slice(0, 120)).filter(Boolean),
      ),
    ).slice(0, 12);
    return {
      ...input,
      note: note || null,
      escalatedTo,
      overrideStance: stance,
      overrideRationale: rationale || null,
      citedFeatures: cited,
      alertConfidence: (input.alertConfidence ?? "unknown").toString().slice(0, 20),
      evidenceSnapshot: (input.evidenceSnapshot ?? []).slice(0, 12),
    };
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
        override_stance: data.overrideStance,
        override_rationale: data.overrideRationale,
        cited_features: data.citedFeatures,
        alert_confidence: data.alertConfidence,
        evidence_snapshot: data.evidenceSnapshot as unknown as never,
      })
      .select(SELECT_COLS)
      .single();
    if (error) throw new Error(error.message);
    return row as unknown as AlertActionRow;
  });

export const listAlertActions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sessionId?: string | null } | undefined) => input ?? {})
  .handler(async ({ data, context }): Promise<AlertActionRow[]> => {
    let q = context.supabase
      .from("ai_alert_actions")
      .select(SELECT_COLS)
      .order("created_at", { ascending: false })
      .limit(100);
    if (data.sessionId) q = q.eq("session_id", data.sessionId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []) as unknown as AlertActionRow[];
  });
