/**
 * Operator script: survey our own hand-recorded cases for bedside monitor
 * readings that never became paired readings, and file the ones that carry
 * both numbers at the same instant.
 *
 * Usage: bun scripts/run-inhouse-intake.ts [--apply]
 * Without --apply it only reports what it found.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import {
  buildInhousePairedRow,
  nearestEpoch,
  planInhouseIntake,
  type EpochSnapshot,
  type InhouseAnnotationEvent,
} from "@/lib/eeg/inhouse-intake";

const APPLY = process.argv.includes("--apply");
const LINEAGE = "muse-2|TP9-AF7-AF8-TP10|256";

const session = JSON.parse(
  readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`, "utf8"),
) as { access_token: string; user_id?: string; user?: { id: string } };

const url = process.env["VITE_SUPABASE_URL"]!;
const key = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_ANON_KEY"]!;
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${session.access_token}` } },
});

const userId = session.user_id ?? session.user?.id;
if (!userId) throw new Error("No user id in the cached session");

const { data: sessionRows, error: sessErr } = await supabase
  .from("eeg_sessions")
  .select("id, context, device_name")
  .eq("user_id", userId);
if (sessErr) throw new Error(sessErr.message);
const sessions = (sessionRows ?? []) as { id: string; context: string | null; device_name: string | null }[];
const sessionIds = sessions.map((s) => s.id);
console.info(`in-house cases: ${sessionIds.length}`);

const { data: eventRows, error: evErr } = await supabase
  .from("eeg_events")
  .select("id, session_id, kind, t_offset_seconds, detail")
  .in("session_id", sessionIds)
  .limit(5000);
if (evErr) throw new Error(evErr.message);
const allEvents = (eventRows ?? []) as (InhouseAnnotationEvent & { kind: string })[];
const annotations = allEvents.filter((e) => e.kind === "annotation");

const { data: pairedRows, error: pErr } = await supabase
  .from("bis_paired_points")
  .select("session_id, at_seconds, external_ref")
  .in("session_id", sessionIds)
  .limit(5000);
if (pErr) throw new Error(pErr.message);
const paired = (pairedRows ?? []) as {
  session_id: string | null;
  at_seconds: number;
  external_ref: string | null;
}[];
const refs = new Set(paired.map((p) => p.external_ref).filter((v): v is string => !!v));
const times = (sid: string, at: number) =>
  paired.some((p) => p.session_id === sid && Math.abs(p.at_seconds - at) < 3);

const { readings, survey } = planInhouseIntake(annotations, refs, times);
console.info("survey", survey, `already stored paired readings: ${paired.length}`);

if (!readings.length) {
  console.info("nothing to recover");
  process.exit(0);
}

const wanted = [...new Set(readings.map((r) => r.sessionId))];
const { data: epochRows } = await supabase
  .from("eeg_epochs")
  .select("session_id, t_offset_seconds, depth_index, suppression_ratio, spectral_edge_95")
  .in("session_id", wanted)
  .limit(20000);
const epochs: EpochSnapshot[] = ((epochRows ?? []) as Record<string, any>[]).map((e) => ({
  sessionId: String(e["session_id"]),
  at: Number(e["t_offset_seconds"]),
  appIndex: e["depth_index"] == null ? null : Number(e["depth_index"]),
  appSr: e["suppression_ratio"] == null ? null : Number(e["suppression_ratio"]),
  appSef: e["spectral_edge_95"] == null ? null : Number(e["spectral_edge_95"]),
}));

const contextOf = new Map(sessions.map((s) => [s.id, s.context ?? "general_anaesthesia"]));
const rows = readings.map((r) => {
  const warning = allEvents.some(
    (e) => e.session_id === r.sessionId && e.kind === "signal_quality" && Math.abs(e.t_offset_seconds - r.at) <= 30,
  );
  return buildInhousePairedRow(r, nearestEpoch(r, epochs), {
    userId,
    lineage: LINEAGE,
    context: contextOf.get(r.sessionId) ?? "general_anaesthesia",
    qualityWarning: warning,
  });
});

for (const row of rows) {
  console.info(
    `case ${row.session_id.slice(0, 8)} @${Math.round(row.at_seconds)}s  monitor ${row.bis}  app ${row.app_index}  ${row.feature_source}${row.reliable ? "" : "  (quality warning)"}`,
  );
}

if (!APPLY) {
  console.info(`dry run — ${rows.length} readings ready; re-run with --apply`);
  process.exit(0);
}

const { error: insErr } = await supabase.from("bis_paired_points").insert(rows as any);
if (insErr) throw new Error(insErr.message);
console.info(`filed ${rows.length} readings into ${LINEAGE}`);
