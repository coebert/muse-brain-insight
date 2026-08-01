import { supabase } from "@/integrations/supabase/client";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";

export interface SessionMeta {
  caseCode: string;
  context: string;
  location: string;
  notes: string;
  deviceName: string;
}

/** Store at most this many epochs per session; older data is decimated evenly. */
const MAX_STORED_EPOCHS = 900;

function decimate(epochs: Epoch[]): Epoch[] {
  if (epochs.length <= MAX_STORED_EPOCHS) return epochs;
  const step = epochs.length / MAX_STORED_EPOCHS;
  const out: Epoch[] = [];
  for (let i = 0; i < MAX_STORED_EPOCHS; i++) out.push(epochs[Math.floor(i * step)]!);
  return out;
}

export async function saveSession(
  meta: SessionMeta,
  epochs: Epoch[],
  events: DetectedEvent[],
  summary: { meanSr: number; maxSr: number; suppressionSeconds: number; seizureAlerts: number },
  elapsed: number,
) {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("You need to be signed in to save a session.");

  const { data: session, error } = await supabase
    .from("eeg_sessions")
    .insert({
      user_id: userId,
      case_code: meta.caseCode,
      context: meta.context,
      location: meta.location || null,
      notes: meta.notes || null,
      device_name: meta.deviceName || null,
      duration_seconds: Math.round(elapsed),
      mean_suppression_ratio: Number(summary.meanSr.toFixed(2)),
      max_suppression_ratio: Number(summary.maxSr.toFixed(2)),
      suppression_seconds: Number(summary.suppressionSeconds.toFixed(1)),
      seizure_alerts: summary.seizureAlerts,
      ended_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;

  const rows = decimate(epochs).map((e) => ({
    session_id: session.id,
    user_id: userId,
    t_offset_seconds: Number(e.t.toFixed(2)),
    suppression_ratio: Number(e.suppressionRatio.toFixed(2)),
    is_suppressed: e.isSuppressed,
    seizure_score: Number(e.seizureScore.toFixed(3)),
    total_power: Number(e.totalPower.toFixed(3)),
    spectral_edge_95: Number(e.sef95.toFixed(2)),
    bands: { ...e.bands } as Record<string, number>,
    spectrum: e.spectrum.map((v) => Number(v.toFixed(1))),
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error: epochError } = await supabase.from("eeg_epochs").insert(rows.slice(i, i + 200));
    if (epochError) throw epochError;
  }

  if (events.length) {
    const { error: eventError } = await supabase.from("eeg_events").insert(
      events.map((ev) => ({
        session_id: session.id,
        user_id: userId,
        kind: ev.kind,
        severity: ev.severity,
        t_offset_seconds: Number(ev.t.toFixed(2)),
        duration_seconds: Number(ev.duration.toFixed(1)),
        detail: ev.detail,
      })),
    );
    if (eventError) throw eventError;
  }

  return session.id as string;
}