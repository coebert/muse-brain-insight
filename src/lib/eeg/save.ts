import { supabase } from "@/integrations/supabase/client";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";
import { sealTexts } from "@/lib/privacy.functions";
import { clearStagedSave, isTransient, stageSave, withRetry } from "@/lib/eeg/save-staging";

export interface SessionMeta {
  caseCode: string;
  context: string;
  location: string;
  notes: string;
  /** Free-text clinical summary written by the clinician. */
  caseSummary: string;
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

/**
 * Run one database write, turning a PostgREST error into a thrown error so the
 * retry policy can see it, and retrying transient failures with backoff.
 */
async function write<T>(
  op: () => PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<T> {
  return withRetry(
    async () => {
      const { data, error } = await op();
      if (error) throw new Error(error.message);
      return data;
    },
    { shouldRetry: isTransient },
  );
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

  // Stage the case locally first so a dropped connection mid-save cannot lose
  // a completed record.
  stageSave(meta.caseCode, { meta, summary, elapsed, events: events.length });

  // Free-text fields are encrypted (AES-256-GCM) before they leave the browser session.
  const { values: sealed } = await sealTexts({
    data: {
      values: [
        meta.caseCode,
        meta.location || null,
        meta.notes || null,
        meta.admissionDiagnosis.trim() || null,
        meta.caseSummary.trim() || null,
      ],
    },
  });
  const [sealedCase, sealedLocation, sealedNotes, sealedDiagnosis, sealedSummary] =
    sealed as (string | null)[];

  const session = await write(() =>
    supabase
      .from("eeg_sessions")
      .insert({
        user_id: userId,
        case_code: sealedCase ?? meta.caseCode,
        context: meta.context,
        location: sealedLocation ?? null,
        notes: sealedNotes ?? null,
        case_summary: sealedSummary ?? null,
        device_name: meta.deviceName || null,
        age_years: (() => {
          const n = meta.ageYears.trim() === "" ? null : Number(meta.ageYears);
          if (n === null || Number.isNaN(n)) return null;
          // Never store an exact age of 90+, which can be identifying.
          return n >= 90 ? null : Math.round(n);
        })(),
        age_band: ageBand(meta.ageYears.trim() === "" ? null : Number(meta.ageYears)),
        sex: meta.sex || null,
        admission_diagnosis: sealedDiagnosis ?? null,
        clinical_features: meta.clinicalFeatures,
        duration_seconds: Math.round(elapsed),
        mean_suppression_ratio: Number(summary.meanSr.toFixed(2)),
        max_suppression_ratio: Number(summary.maxSr.toFixed(2)),
        suppression_seconds: Number(summary.suppressionSeconds.toFixed(1)),
        seizure_alerts: summary.seizureAlerts,
        ended_at: new Date().toISOString(),
      })
      .select("id")
      .single(),
  );
  if (!session) throw new Error("The case was not saved — no record was returned.");

  const rows = decimate(epochs).map((e) => ({
    session_id: session.id,
    user_id: userId,
    t_offset_seconds: Number(e.t.toFixed(2)),
    suppression_ratio: Number(e.suppressionRatio.toFixed(2)),
    is_suppressed: e.isSuppressed,
    seizure_score: Number(e.seizureScore.toFixed(3)),
    total_power: Number(e.totalPower.toFixed(3)),
    spectral_edge_95: Number(e.sef95.toFixed(2)),
    depth_index: e.depth.index === null ? null : Number(e.depth.index.toFixed(1)),
    depth_state: e.depth.state,
    consciousness_index: e.composite.cIndex,
    nociception_index: e.composite.nIndex,
    composite_components: {
      fast_slow: Number(e.composite.components.fastSlow.toFixed(3)),
      entropy: Number(e.composite.components.entropy.toFixed(3)),
      bsr: Number(e.composite.components.bsr.toFixed(2)),
      emg_drive: Number(e.composite.components.emgDrive.toFixed(3)),
      reactivity: Number(e.composite.components.reactivity.toFixed(3)),
      entropy_gap: Number(e.composite.components.entropyGap.toFixed(3)),
    } as Record<string, number>,
    depth_components: {
      c1: Number.isFinite(e.depth.components.betaRatio)
        ? Number(e.depth.components.betaRatio.toFixed(4))
        : null,
      c2: Number.isFinite(e.depth.components.synchFastSlow)
        ? Number(e.depth.components.synchFastSlow.toFixed(4))
        : null,
      c3: Number.isFinite(e.depth.components.slowWave)
        ? Number(e.depth.components.slowWave.toFixed(4))
        : null,
      bsr: Number(e.depth.components.bsr.toFixed(2)),
    } as Record<string, number | null>,
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
    const chunk = rows.slice(i, i + 200);
    await write(() => supabase.from("eeg_epochs").insert(chunk));
  }

  if (events.length) {
    const eventRows = events.map((ev) => ({
      session_id: session.id,
      user_id: userId,
      kind: ev.kind,
      severity: ev.severity,
      t_offset_seconds: Number(ev.t.toFixed(2)),
      duration_seconds: Number(ev.duration.toFixed(1)),
      detail: ev.detail,
    }));
    await write(() => supabase.from("eeg_events").insert(eventRows));
  }

  clearStagedSave();
  return session.id as string;
}
