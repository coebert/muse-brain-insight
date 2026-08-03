/**
 * Row shape and mapping for `ai_alert_actions`.
 *
 * Kept out of the server-function module so the mapper is a plain runtime
 * helper (server-function files must stay thin) and so the persisted columns
 * are derived from the generated schema types rather than hand-written.
 */
import type { Tables } from "@/integrations/supabase/types";
import type { AlertEvidence } from "@/lib/eeg/interpret.functions";

export type AlertActionKind = "acknowledged" | "escalated" | "resolved";

/** Where the clinician stands relative to the AI's read of the alert. */
export type OverrideStance = "agree" | "partial" | "override" | "defer";

type DbAlertAction = Tables<"ai_alert_actions">;

export type AlertActionRow = Omit<
  DbAlertAction,
  "user_id" | "action" | "override_stance" | "evidence_snapshot"
> & {
  action: AlertActionKind;
  override_stance: OverrideStance;
  evidence_snapshot: AlertEvidence[];
};

export const ALERT_ACTION_COLUMNS =
  "id, session_id, alert_id, alert_title, alert_category, alert_severity, action, note, escalated_to, context, created_at, override_stance, override_rationale, cited_features, alert_confidence, evidence_snapshot" as const;

type SelectedRow = Omit<DbAlertAction, "user_id">;

/** Narrow the free-text/JSON columns of a stored row to the app's unions. */
export function toAlertActionRow(row: SelectedRow): AlertActionRow {
  const { action, override_stance, evidence_snapshot, ...rest } = row;
  return {
    ...rest,
    action: action as AlertActionKind,
    override_stance: override_stance as OverrideStance,
    evidence_snapshot: Array.isArray(evidence_snapshot)
      ? (evidence_snapshot as unknown[] as AlertEvidence[])
      : [],
  };
}
