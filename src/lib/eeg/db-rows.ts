/**
 * Shared row types and fetch helpers for the persisted EEG tables.
 *
 * Types are derived from the generated database schema so review screens
 * (trends, compare, report, calibrate) stay in step with migrations instead
 * of each keeping a hand-written interface and casting the query result.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type EegEpoch = Tables<"eeg_epochs">;
export type EegEvent = Tables<"eeg_events">;
export type EegSession = Tables<"eeg_sessions">;

/** Columns every review screen needs from an epoch. */
export const EPOCH_COLUMNS =
  "t_offset_seconds, depth_index, spectral_edge_95, suppression_ratio, seizure_score, is_suppressed, consciousness_index, nociception_index, entropy, spectrum, depth_components" as const;

export type EpochRow = Pick<
  EegEpoch,
  | "t_offset_seconds"
  | "depth_index"
  | "spectral_edge_95"
  | "suppression_ratio"
  | "seizure_score"
  | "is_suppressed"
  | "consciousness_index"
  | "nociception_index"
  | "entropy"
  | "spectrum"
  | "depth_components"
>;

export const EVENT_COLUMNS =
  "t_offset_seconds, duration_seconds, kind, severity, detail" as const;

export type EventRow = Pick<
  EegEvent,
  "t_offset_seconds" | "duration_seconds" | "kind" | "severity" | "detail"
>;

/** Ordered epochs for a session. */
export async function fetchEpochs(sessionId: string): Promise<EpochRow[]> {
  const { data, error } = await supabase
    .from("eeg_epochs")
    .select(EPOCH_COLUMNS)
    .eq("session_id", sessionId)
    .order("t_offset_seconds", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Ordered events for a session. */
export async function fetchEvents(sessionId: string): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("eeg_events")
    .select(EVENT_COLUMNS)
    .eq("session_id", sessionId)
    .order("t_offset_seconds", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Narrow the JSON entropy column to the state/response pair the UI reads. */
export function entropyOf(row: { entropy: unknown }): { state?: number; response?: number } | null {
  return (row.entropy ?? null) as { state?: number; response?: number } | null;
}
