/**
 * Turns unfiled continuous captures into anonymised cases the models can learn
 * from.
 *
 * A recording that the clinician never filed still contains real signal. Once
 * it has been quiet for long enough to be certainly finished, this step files
 * it as a case of its own, marked as automatically harvested, and copies its
 * epochs into the normal training tables. A capture that was filed by hand is
 * skipped, so nothing is counted twice.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { HARVEST_MIN_EPOCHS, HARVEST_QUIET_HOURS } from "./capture-harvest.constants";

type Client = SupabaseClient<any, any, any>;

export { HARVEST_MIN_EPOCHS, HARVEST_QUIET_HOURS } from "./capture-harvest.constants";
/** Bounded work per scheduled run. */
export const HARVEST_MAX_CAPTURES = 5;
/** Rows kept per harvested case, matching the manual save path. */
export const HARVEST_MAX_EPOCHS = 900;

export interface HarvestReport {
  considered: number;
  harvested: number;
  epochsCopied: number;
  errors: string[];
}

/** Even thinning, so a long case keeps its shape rather than only its start. */
function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const stride = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * stride)]!);
  return out;
}

/**
 * Files one capture as a case. Shared by the scheduled harvest and by the
 * clinician's "recover now" action, so a recording that was lost to a dropout
 * can be brought back without waiting for the quiet window.
 *
 * `maxEpochs` is the number of readings kept on the case timeline. Recovery
 * keeps far more than the scheduled harvest, because the clinician is
 * recovering a specific case rather than topping up the training pool.
 */
export async function harvestOneCapture(
  admin: Client,
  capture: Record<string, any>,
  maxEpochs: number = HARVEST_MAX_EPOCHS,
): Promise<{ sessionId: string; epochsCopied: number } | null> {
  const { data: epochRows, error: epochError } = await admin
    .from("capture_epochs")
    .select(
      "at_seconds, depth_index, sef95, suppression_ratio, epoch_suppression, total_power, bands, ratios, spectrum",
    )
    .eq("capture_id", capture["id"])
    .order("epoch_index", { ascending: true })
    .limit(20000);
  if (epochError) throw new Error(epochError.message);
  const all = (epochRows ?? []) as Record<string, any>[];
  if (!all.length) return null;

  const srs = all.map((r) => Number(r["suppression_ratio"] ?? 0));
  const meanSr = srs.reduce((a, b) => a + b, 0) / srs.length;
  const maxSr = srs.reduce((a, b) => Math.max(a, b), 0);
  const suppressionSeconds = all.reduce(
    (a, r) => a + (Number(r["epoch_suppression"] ?? 0) >= 0.5 ? 1 : 0),
    0,
  );
  const lastAt = Number(all[all.length - 1]!["at_seconds"] ?? 0);
  const startedAt = new Date(capture["started_at"] as string);

  const { data: session, error: sessionError } = await admin
    .from("eeg_sessions")
    .insert({
      user_id: capture["user_id"],
      // Recovered cases are labelled as such so nobody mistakes one for a
      // clinician-reviewed record.
      case_code: `AUTO-${String(capture["capture_key"]).slice(0, 8).toUpperCase()}`,
      context: "general_anaesthesia",
      notes: null,
      device_name: capture["device_name"],
      started_at: startedAt.toISOString(),
      ended_at: new Date(startedAt.getTime() + lastAt * 1000).toISOString(),
      duration_seconds: Math.round(lastAt),
      mean_suppression_ratio: Number(meanSr.toFixed(2)),
      max_suppression_ratio: Number(maxSr.toFixed(2)),
      suppression_seconds: suppressionSeconds,
      seizure_alerts: 0,
    })
    .select("id")
    .single();
  if (sessionError) throw new Error(sessionError.message);
  const sessionId = (session as { id: string }).id;

  const kept = thin(all, maxEpochs);
  let epochsCopied = 0;
  for (let i = 0; i < kept.length; i += 200) {
    const chunk = kept.slice(i, i + 200).map((r) => ({
      session_id: sessionId,
      user_id: capture["user_id"],
      t_offset_seconds: Number(r["at_seconds"] ?? 0),
      suppression_ratio: r["suppression_ratio"],
      is_suppressed: Number(r["epoch_suppression"] ?? 0) >= 0.5,
      seizure_score: 0,
      total_power: r["total_power"],
      spectral_edge_95: r["sef95"],
      bands: r["bands"] ?? {},
      power_ratios: r["ratios"] ?? {},
      spectrum: r["spectrum"] ?? [],
      depth_index: r["depth_index"],
    }));
    const { error: insertError } = await admin.from("eeg_epochs").insert(chunk as never);
    if (insertError) throw new Error(insertError.message);
    epochsCopied += chunk.length;
  }

  await admin
    .from("capture_sessions")
    .update({ harvested_session_id: sessionId, harvested_at: new Date().toISOString() })
    .eq("id", capture["id"]);

  return { sessionId, epochsCopied };
}

export async function harvestCaptures(admin: Client): Promise<HarvestReport> {
  const report: HarvestReport = { considered: 0, harvested: 0, epochsCopied: 0, errors: [] };
  const cutoff = new Date(Date.now() - HARVEST_QUIET_HOURS * 3600_000).toISOString();

  const { data: captures, error } = await admin
    .from("capture_sessions")
    .select("id, user_id, capture_key, started_at, last_seen_at, device_name, epoch_count")
    .is("filed_session_id", null)
    .is("harvested_session_id", null)
    .lt("last_seen_at", cutoff)
    .gte("epoch_count", HARVEST_MIN_EPOCHS)
    .order("last_seen_at", { ascending: true })
    .limit(HARVEST_MAX_CAPTURES);
  if (error) {
    report.errors.push(error.message);
    return report;
  }

  for (const capture of (captures ?? []) as Record<string, any>[]) {
    // Belt and braces for captures written before the demo signal was excluded
    // client-side: a simulated recording must never become a case.
    const device = String(capture["device_name"] ?? "");
    if (/demo|simulat|test/i.test(device)) continue;
    if (Number(capture["epoch_count"] ?? 0) < HARVEST_MIN_EPOCHS) continue;
    report.considered += 1;
    try {
      const done = await harvestOneCapture(admin, capture);
      if (!done) continue;
      report.epochsCopied += done.epochsCopied;
      report.harvested += 1;
    } catch (err) {
      report.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return report;
}

