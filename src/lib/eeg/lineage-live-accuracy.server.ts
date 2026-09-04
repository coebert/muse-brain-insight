/**
 * Server-side loader for live COEBIS accuracy: the training matrix as it
 * stands right now, scored against whichever model version is active for each
 * acquisition lineage.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CoebisModel } from "./coebis-covariates";
import { modelFromRow } from "./coebis-refit.server";
import { loadTrainingMatrix } from "./coebis-training.server";
import {
  summariseLiveAccuracy,
  type LiveAccuracyReport,
} from "./lineage-live-accuracy";

type Client = SupabaseClient<any, any, any>;

/** Minutes between scheduled refit ticks; mirrors the cron entry. */
export const REFIT_TICK_MINUTES = 15;

export async function loadLiveAccuracy(
  supabase: Client,
  userId: string,
  limit = 120000,
): Promise<LiveAccuracyReport> {
  const matrix = await loadTrainingMatrix(supabase, limit, userId, 40000);

  const { data: versionRows } = await supabase
    .from("coebis_model_versions")
    .select("lineage_key, version, model_family, coefficients, is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("version", { ascending: false });

  const incumbents = new Map<string, { model: CoebisModel; version: number | null }>();
  for (const raw of (versionRows ?? []) as unknown as Record<string, unknown>[]) {
    const key = String(raw["lineage_key"]);
    if (incumbents.has(key)) continue;
    const model = modelFromRow(raw);
    if (model) incumbents.set(key, { model, version: Number(raw["version"]) });
  }

  const { data: runRow } = await supabase
    .from("coebis_refit_runs")
    .select("started_at, finished_at, status")
    .eq("user_id", userId)
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: stateRow } = await supabase
    .from("coebis_refit_state")
    .select("status, paused_reason")
    .eq("job_key", "coebis-refit")
    .maybeSingle();

  return summariseLiveAccuracy(matrix.points, incumbents, {
    lastRefitAt: (runRow as { started_at?: string } | null)?.started_at ?? null,
    schedulerStatus: (stateRow as { status?: string } | null)?.status ?? "running",
    schedulerNote: (stateRow as { paused_reason?: string | null } | null)?.paused_reason ?? null,
    tickMinutes: REFIT_TICK_MINUTES,
  });
}
