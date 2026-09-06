/** Server-only helpers for outcome linkage (Phase 6). */
import type { SupabaseClient } from "@supabase/supabase-js";

import { open as unseal } from "@/lib/privacy.server";

import type { CaseOutcome, OutcomeCase } from "./outcomes";

type Client = SupabaseClient<any, any, any>;

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function rowToOutcome(row: Record<string, unknown>): CaseOutcome {
  return {
    id: String(row["id"]),
    sessionId: String(row["session_id"]),
    delirium: String(row["delirium"] ?? "unknown"),
    deliriumDays: num(row["delirium_days"]),
    emergence: String(row["emergence"] ?? "unknown"),
    awareness: Boolean(row["awareness"]),
    unplannedIcu: Boolean(row["unplanned_icu"]),
    mortality30d: Boolean(row["mortality_30d"]),
    lengthOfStayDays: num(row["length_of_stay_days"]),
    notes: (row["notes"] as string | null) ?? null,
  };
}

/** Depth/suppression exposure per case, joined to whatever outcome is filed. */
export async function loadOutcomeCases(supabase: Client, limit = 200): Promise<OutcomeCase[]> {
  const { data: sessions, error } = await supabase
    .from("eeg_sessions")
    .select(
      "id, case_code, age_band, duration_seconds, mean_suppression_ratio, suppression_seconds, started_at",
    )
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (sessions ?? []) as unknown as Record<string, unknown>[];
  const ids = rows.map((r) => String(r["id"]));
  if (!ids.length) return [];

  const { data: outcomeRows } = await supabase.from("case_outcomes").select("*").in("session_id", ids);
  const outcomes = new Map<string, CaseOutcome>();
  for (const r of (outcomeRows ?? []) as unknown as Record<string, unknown>[]) {
    outcomes.set(String(r["session_id"]), rowToOutcome(r));
  }

  // Depth exposure is aggregated in the database: paging every epoch row
  // through the API silently truncated long cases at the API's row cap.
  const depth = new Map<string, { mean: number; n: number; deepEpochs: number }>();
  const { data: exposureRows, error: exposureError } = await supabase.rpc(
    "session_depth_exposure",
    { _session_ids: ids },
  );
  if (exposureError) throw new Error(exposureError.message);
  for (const r of (exposureRows ?? []) as unknown as Record<string, unknown>[]) {
    const n = num(r["epochs"]) ?? 0;
    const mean = num(r["mean_depth"]);
    if (!n || mean == null) continue;
    depth.set(String(r["session_id"]), {
      mean,
      n,
      deepEpochs: num(r["deep_epochs"]) ?? 0,
    });
  }


  return rows.map((r) => {
    const id = String(r["id"]);
    const d = depth.get(id);
    const durationSeconds = num(r["duration_seconds"]) ?? 0;
    // Epochs are evenly spaced, so the deep fraction maps onto case minutes.
    const deepFraction = d && d.n ? d.deepEpochs / d.n : 0;
    return {
      sessionId: id,
      caseCode: unseal(r["case_code"] as string | null) ?? "",
      ageBand: (r["age_band"] as string | null) ?? null,
      startedAt: (r["started_at"] as string | null) ?? null,
      durationMinutes: Number((durationSeconds / 60).toFixed(1)),
      meanDepth: d && d.n ? Number((d.sum / d.n).toFixed(1)) : null,
      minutesDeep: Number(((deepFraction * durationSeconds) / 60).toFixed(1)),
      meanSr: Number((num(r["mean_suppression_ratio"]) ?? 0).toFixed(1)),
      minutesSuppressed: Number(((num(r["suppression_seconds"]) ?? 0) / 60).toFixed(1)),
      outcome: outcomes.get(id) ?? null,
    } satisfies OutcomeCase;
  });
}
