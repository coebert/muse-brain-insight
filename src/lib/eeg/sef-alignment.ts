/**
 * Client-side loading of the active SEF correction — the gain/offset the app
 * has fitted from paired SEF readings transcribed off a commercial monitor.
 * Applied to the live spectral edge so the bedside number sits on the scale
 * the clinician reads on the monitor.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  SEF_MIN_POINTS,
  SEF_MIN_SESSIONS,
  setActiveSefAlignment,
  getActiveSefAlignment,
  type SefAlignment,
} from "@/lib/eeg/sef-drift";
import {
  setActiveSefPersonalModel,
  type SefPersonalModel,
} from "@/lib/eeg/sef-personalisation";

let syncedAt = 0;
const listeners = new Set<(alignment: SefAlignment | null) => void>();

export function getSyncedSefAlignment(): SefAlignment | null {
  return getActiveSefAlignment();
}

export function onSefAlignmentChange(fn: (alignment: SefAlignment | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Load the active correction and put it in force for the live analyzer. */
export async function syncSefAlignment(): Promise<SefAlignment | null> {
  const { data, error } = await supabase
    .from("sef_alignments")
    .select(
      'id, gain, "offset", n_points, n_sessions, created_at, bias_after, mae_after, model_family, coefficients, cv_metrics, n_patients',
    )
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);
  syncedAt = Date.now();
  if (error || !data || !data.length) {
    setActiveSefPersonalModel(null);
    setActiveSefAlignment(null);
    listeners.forEach((fn) => fn(null));
    return null;
  }
  const row = data[0]!;
  const gain = Number(row.gain);
  const offset = Number(row.offset);
  if (!Number.isFinite(gain) || !Number.isFinite(offset)) return null;
  const points = Number(row.n_points) || 0;
  const sessions = Number(row.n_sessions) || 0;
  const alignment: SefAlignment = {
    gain,
    offset,
    n: points,
    sessions,
    fittedAt: String(row.created_at),
    id: String(row.id),
    provisional: points < SEF_MIN_POINTS || sessions < SEF_MIN_SESSIONS,
    biasAfter: row.bias_after === null ? null : Number(row.bias_after),
    maeAfter: row.mae_after === null ? null : Number(row.mae_after),
  };
  // A personalised row carries the covariate terms and the per-patient
  // longitudinal offsets alongside the same base line, so the live analyzer
  // can apply them without a second round trip.
  const coefficients = (row.coefficients ?? null) as
    | { terms?: SefPersonalModel["terms"]; patientOffsets?: Record<string, number> }
    | null;
  if (row.model_family === "personal" && coefficients && Array.isArray(coefficients.terms)) {
    setActiveSefPersonalModel({
      gain,
      offset,
      terms: coefficients.terms,
      patientOffsets: coefficients.patientOffsets ?? {},
      n: points,
      sessions,
      patients: Number(row.n_patients) || 0,
      cv: (row.cv_metrics ?? {}) as unknown as SefPersonalModel["cv"],
      fittedAt: String(row.created_at),
      id: String(row.id),
    });
  } else {
    setActiveSefPersonalModel(null);
  }
  setActiveSefAlignment(alignment);
  listeners.forEach((fn) => fn(alignment));
  return alignment;
}

/** Re-sync only when the cached model is older than `maxAgeMs`. */
export async function syncSefAlignmentIfStale(maxAgeMs: number): Promise<SefAlignment | null> {
  if (Date.now() - syncedAt < maxAgeMs) return getActiveSefAlignment();
  return syncSefAlignment();
}

/** One-line description for tiles and info popovers. */
export function describeSefAlignment(alignment: SefAlignment | null): string {
  if (!alignment) return "Raw headband SEF — no paired monitor readings fitted yet";
  const fitted = new Date(alignment.fittedAt);
  const when = Number.isNaN(fitted.getTime())
    ? ""
    : ` · fitted ${fitted.toLocaleDateString(undefined, { day: "2-digit", month: "short" })}`;
  return `Aligned to monitor SEF (${alignment.gain.toFixed(2)}× ${alignment.offset >= 0 ? "+" : "−"} ${Math.abs(
    alignment.offset,
  ).toFixed(2)} Hz) · ${alignment.n} readings${alignment.provisional ? " · provisional" : ""}${when}`;
}