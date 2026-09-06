/**
 * Server side of the headband depth score comparison.
 *
 * Loads the Muse/Regul8 recordings' scored epochs, the promoted headband-only
 * depth model, and the promoted suppression model, then scores every epoch
 * under both. Reads are paged and capped so a long recording cannot pull the
 * whole timeline into memory.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CoebisModel } from "./coebis-covariates";
import {
  compareHeadbandToSuppression,
  type HeadbandEpoch,
  type HeadbandScoreComparison,
} from "./headband-depth-scores";

type Client = SupabaseClient<any, any, any>;

const PAGE = 1000;

/** Recording setups that come from a headband rather than a research corpus. */
export const HEADBAND_LINEAGE_KEY = "muse-2|TP9-AF7-AF8-TP10|256";

interface SessionRow {
  id: string;
  case_code: string | null;
}

async function loadHeadbandSessions(
  supabase: Client,
  userId: string,
  limit: number,
): Promise<SessionRow[]> {
  const { data, error } = await supabase
    .from("eeg_sessions")
    .select("id, case_code")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SessionRow[];
}

async function loadEpochs(
  supabase: Client,
  userId: string,
  sessions: SessionRow[],
  maxRows: number,
): Promise<HeadbandEpoch[]> {
  const codes = new Map(sessions.map((s) => [s.id, s.case_code] as const));
  const ids = sessions.map((s) => s.id);
  if (!ids.length) return [];
  const out: HeadbandEpoch[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await supabase
      .from("eeg_epochs")
      .select("session_id, t_offset_seconds, depth_index, suppression_ratio")
      .eq("user_id", userId)
      .in("session_id", ids)
      .not("depth_index", "is", null)
      .order("t_offset_seconds", { ascending: true })
      .range(from, Math.min(from + PAGE, maxRows) - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of rows) {
      const index = Number(r["depth_index"]);
      if (!Number.isFinite(index)) continue;
      const sessionId = String(r["session_id"]);
      out.push({
        sessionId,
        caseCode: codes.get(sessionId) ?? null,
        atSeconds: Number(r["t_offset_seconds"]) || 0,
        rawIndex: index,
        appSr: Number(r["suppression_ratio"]) || 0,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadHeadbandModel(
  supabase: Client,
  userId: string,
): Promise<CoebisModel | null> {
  const { data, error } = await supabase
    .from("coebis_model_versions")
    .select("coefficients, model_family, is_active, version")
    .eq("user_id", userId)
    .eq("lineage_key", HEADBAND_LINEAGE_KEY)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1);
  if (error) return null;
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const { modelFromRow } = await import("@/lib/eeg/coebis-refit.server");
  try {
    return modelFromRow(row);
  } catch {
    return null;
  }
}

export interface HeadbandScoreReport extends HeadbandScoreComparison {
  /** Recordings looked at, whether or not they had scored epochs. */
  recordings: number;
}

export async function getHeadbandScoreReport(
  supabase: Client,
  userId: string,
  options: { sessions?: number; rows?: number } = {},
): Promise<HeadbandScoreReport> {
  const sessions = await loadHeadbandSessions(supabase, userId, options.sessions ?? 40);
  const [epochs, depth] = await Promise.all([
    loadEpochs(supabase, userId, sessions, options.rows ?? 20000),
    loadHeadbandModel(supabase, userId),
  ]);

  const { loadActiveSuppressionModel } = await import("@/lib/eeg/suppression-promotion.server");
  const { SR_LINEAGE_PREFIX } = await import("@/lib/eeg/suppression-model.server");
  const active = await loadActiveSuppressionModel(supabase, userId, SR_LINEAGE_PREFIX).catch(
    () => null,
  );

  const comparison = compareHeadbandToSuppression(epochs, depth, active ? active.model : null);
  return { ...comparison, recordings: sessions.length };
}
