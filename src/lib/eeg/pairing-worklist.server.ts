/**
 * Server-side loader for the pairing worklist: which stored recordings on a
 * lineage still have EEG without monitor readings, and which moments in them
 * are worth pairing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { selectValidatedPoints } from "./coebis-refit";
import { loadTrainingMatrix } from "./coebis-training.server";
import {
  planPairing,
  suggestMoments,
  type PairingCandidate,
  type PairingMoment,
  type PairingWorklist,
} from "./pairing-worklist";

type Client = SupabaseClient<any, any, any>;

/** Acquisition setup the headband records under. */
export const MUSE_LINEAGE_KEY = "muse-2|TP9-AF7-AF8-TP10|256";

/** Recordings are attributed to a lineage by the device they were taken with. */
function matchesLineage(deviceName: string | null, lineageKey: string): boolean {
  const device = (deviceName ?? "").toLowerCase();
  const deviceId = lineageKey.split("|")[0] ?? "";
  if (deviceId.startsWith("muse")) return device.includes("muse");
  return device.includes(deviceId.split("-")[0] ?? deviceId);
}

export async function loadPairingWorklist(
  supabase: Client,
  userId: string,
  lineageKey = MUSE_LINEAGE_KEY,
): Promise<PairingWorklist> {
  const matrix = await loadTrainingMatrix(supabase, 20000, userId, 20000);
  const onLineage = matrix.points.filter((p) => (p.lineageKey ?? null) === lineageKey);
  const validated = selectValidatedPoints(onLineage).used;
  const state = {
    validated: validated.length,
    cases: new Set(validated.map((p) => p.sessionId).filter(Boolean)).size,
  };

  const { data: sessionRows } = await supabase
    .from("eeg_sessions")
    .select("id, case_code, device_name, started_at, duration_seconds")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(200);

  const sessions = ((sessionRows ?? []) as unknown as Record<string, unknown>[]).filter((s) =>
    matchesLineage((s["device_name"] as string | null) ?? null, lineageKey),
  );

  const pairedBySession = new Map<string, number>();
  for (const p of onLineage) {
    if (!p.sessionId) continue;
    pairedBySession.set(p.sessionId, (pairedBySession.get(p.sessionId) ?? 0) + 1);
  }

  const candidates: Omit<PairingCandidate, "suggested">[] = [];
  for (const s of sessions) {
    const id = String(s["id"]);
    const { count: epochs } = await supabase
      .from("eeg_epochs")
      .select("id", { count: "exact", head: true })
      .eq("session_id", id);
    const { count: indexEpochs } = await supabase
      .from("eeg_epochs")
      .select("id", { count: "exact", head: true })
      .eq("session_id", id)
      .not("depth_index", "is", null);
    if (!epochs) continue;
    candidates.push({
      sessionId: id,
      caseCode: (s["case_code"] as string | null) ?? null,
      startedAt: String(s["started_at"]),
      durationSeconds: Number(s["duration_seconds"] ?? 0),
      epochs: epochs ?? 0,
      indexEpochs: indexEpochs ?? 0,
      paired: pairedBySession.get(id) ?? 0,
    });
  }

  return planPairing(lineageKey, state, candidates);
}

/** Moments in one recording that are worth pairing with a monitor value. */
export async function loadPairingMoments(
  supabase: Client,
  userId: string,
  sessionId: string,
  count: number,
): Promise<PairingMoment[]> {
  const rows: PairingMoment[] = [];
  const PAGE = 1000;
  for (let from = 0; from < 4000; from += PAGE) {
    const { data, error } = await supabase
      .from("eeg_epochs")
      .select("t_offset_seconds, depth_index, suppression_ratio, spectral_edge_95, depth_state")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .not("depth_index", "is", null)
      .order("t_offset_seconds", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of page) {
      rows.push({
        at: Number(r["t_offset_seconds"]),
        appIndex: Number(r["depth_index"]),
        appSr: r["suppression_ratio"] == null ? null : Number(r["suppression_ratio"]),
        appSef: r["spectral_edge_95"] == null ? null : Number(r["spectral_edge_95"]),
        state: (r["depth_state"] as string | null) ?? null,
      });
    }
    if (page.length < PAGE) break;
  }
  return suggestMoments(rows, count);
}
