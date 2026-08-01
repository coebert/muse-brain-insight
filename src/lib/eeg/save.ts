import { supabase } from "@/integrations/supabase/client";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";

export interface SessionMeta {
  caseCode: string;
  context: string;
  location: string;
  notes: string;
  deviceName: string;
  /** Age in whole years; ages ≥ 90 are stored as a band only. */
  ageYears: string;
  sex: string;
  admissionDiagnosis: string;
  clinicalFeatures: string[];
}

/** Coarse banding keeps records non-identifying even when age is recorded. */
export function ageBand(age: number | null): string | null {
  if (age === null || Number.isNaN(age)) return null;
  if (age < 18) return "<18";
  if (age < 40) return "18-39";
  if (age < 60) return "40-59";
  if (age < 75) return "60-74";
  if (age < 90) return "75-89";
  return "90+";
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
      age_years: (() => {
        const n = meta.ageYears.trim() === "" ? null : Number(meta.ageYears);
        if (n === null || Number.isNaN(n)) return null;
        // Never store an exact age of 90+, which can be identifying.
        return n >= 90 ? null : Math.round(n);
      })(),
      age_band: ageBand(meta.ageYears.trim() === "" ? null : Number(meta.ageYears)),
      sex: meta.sex || null,
      admission_diagnosis: meta.admissionDiagnosis.trim() || null,
      clinical_features: meta.clinicalFeatures,
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
    entropy: {
      shannon: Number(e.entropy.shannon.toFixed(3)),
      se95: Number(e.entropy.se95.toFixed(3)),
      state: Number(e.entropy.state.toFixed(3)),
      response: Number(e.entropy.response.toFixed(3)),
    } as Record<string, number>,
    power_ratios: {
      delta_alpha: Number(e.ratios.deltaAlpha.toFixed(3)),
      beta_alpha: Number(e.ratios.betaAlpha.toFixed(3)),
      theta_alpha: Number(e.ratios.thetaAlpha.toFixed(3)),
    } as Record<string, number>,
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