import {
  EMPTY_NOTE,
  noteCompleteness,
  patientKeyFor,
  readingCaveat,
  summariseCases,
  type PatientCaseSummary,
  type PatientContextNote,
  type PatientNoteCard,
} from "@/lib/eeg/patient-notes";
import { open, seal } from "@/lib/privacy.server";

/** Minimal shape of the Supabase client used here. */
type Client = {
  from: (table: string) => any;
  rpc: (fn: "session_index_spread") => any;
};



interface SessionRow {
  id: string;
  case_code: string | null;
  patient_pseudonym: string | null;
  patient_link_id: string | null;
  started_at: string;
  duration_seconds: number | null;
  mean_suppression_ratio: number | null;
  max_suppression_ratio: number | null;
  suppression_seconds: number | null;
  seizure_alerts: number | null;
  age_band: string | null;
  sex: string | null;
  regimen: string | null;
}

const SESSION_COLUMNS =
  "id, case_code, patient_pseudonym, patient_link_id, started_at, duration_seconds, mean_suppression_ratio, max_suppression_ratio, suppression_seconds, seizure_alerts, age_band, sex, regimen";

/** Newest cases first, capped so the page stays quick on a large archive. */
const MAX_SESSIONS = 60;


const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Per-session median/min/max recorded depth index, computed in the database. */
async function loadIndexSpread(
  supabase: Client,
): Promise<Map<string, { median: number | null; min: number | null; max: number | null }>> {
  const { data, error } = await supabase.rpc("session_index_spread");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as {
    session_id: string;
    median_index: number | string | null;
    min_index: number | string | null;
    max_index: number | string | null;
  }[];
  const out = new Map<string, { median: number | null; min: number | null; max: number | null }>();
  for (const row of rows) {
    out.set(row.session_id, {
      median: num(row.median_index),
      min: num(row.min_index),
      max: num(row.max_index),
    });
  }
  return out;
}


interface NoteRow {
  patient_key: string;
  patient_label: string | null;
  context_sealed: string | null;
  baseline_sealed: string | null;
  confounders_sealed: string | null;
  read_with_sealed: string | null;
  updated_at: string | null;
}

export interface PatientNotesReport {
  patients: PatientNoteCard[];
  /** Patients with nothing written down at all. */
  withoutContext: number;
  /** Patients whose context is complete. */
  withFullContext: number;
  casesCovered: number;
}

/** Every patient in the archive, their recorded numbers and the context beside them. */
export async function loadPatientNotes(
  supabase: Client,
  userId: string,
): Promise<PatientNotesReport> {
  const { data: sessionData, error: sessionError } = await supabase
    .from("eeg_sessions")
    .select(SESSION_COLUMNS)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(MAX_SESSIONS);
  if (sessionError) throw new Error(sessionError.message);
  const sessions = (sessionData ?? []) as SessionRow[];

  const spreads = await loadIndexSpread(supabase);


  const { data: noteData, error: noteError } = await supabase
    .from("patient_context_notes")
    .select(
      "patient_key, patient_label, context_sealed, baseline_sealed, confounders_sealed, read_with_sealed, updated_at",
    )
    .eq("user_id", userId);
  if (noteError) throw new Error(noteError.message);
  const notes = new Map<string, PatientContextNote>();
  for (const row of (noteData ?? []) as NoteRow[]) {
    notes.set(row.patient_key, {
      context: open(row.context_sealed) ?? "",
      baseline: open(row.baseline_sealed) ?? "",
      confounders: open(row.confounders_sealed) ?? "",
      readWith: open(row.read_with_sealed) ?? "",
      updatedAt: row.updated_at,
    });
  }

  const grouped = new Map<
    string,
    { linked: boolean; label: string; session: SessionRow; cases: PatientCaseSummary[] }
  >();

  for (const session of sessions) {
    // Case codes and pseudonyms are encrypted at rest; read them back before
    // grouping, so a patient's cases collect under one card and the heading is
    // legible rather than ciphertext.
    const caseCode = open(session.case_code) ?? "Untitled case";
    const pseudonym = open(session.patient_pseudonym);
    const { key, linked } = patientKeyFor({
      id: session.id,
      patient_link_id: session.patient_link_id,
      patient_pseudonym: pseudonym,
    });
    const spread = spreads.get(session.id) ?? { median: null, min: null, max: null };
    const summary: PatientCaseSummary = {
      sessionId: session.id,
      caseCode,
      startedAt: session.started_at,
      durationMinutes: Math.round((num(session.duration_seconds) ?? 0) / 60),
      meanSuppressionPct: num(session.mean_suppression_ratio),
      maxSuppressionPct: num(session.max_suppression_ratio),
      suppressionMinutes: Math.round((num(session.suppression_seconds) ?? 0) / 60),
      seizureAlerts: Math.round(num(session.seizure_alerts) ?? 0),
      medianIndex: spread.median,
      minIndex: spread.min,
      maxIndex: spread.max,
    };
    const existing = grouped.get(key);
    if (existing) existing.cases.push(summary);
    else {
      grouped.set(key, {
        linked,
        label: linked
          ? (pseudonym ?? `Patient ${session.patient_link_id?.slice(0, 8) ?? ""}`)
          : caseCode,
        session,
        cases: [summary],
      });

    }
  }

  const patients: PatientNoteCard[] = [];
  for (const [patientKey, group] of grouped) {
    const note = notes.get(patientKey) ?? EMPTY_NOTE;
    const numbers = summariseCases(group.cases);
    patients.push({
      patientKey,
      label: group.label,
      linked: group.linked,
      ageBand: group.session.age_band,
      sex: group.session.sex,
      regimen: group.session.regimen,
      numbers,
      cases: group.cases,
      note,
      completeness: noteCompleteness(note),
      caveat: readingCaveat(numbers, note),
    });
  }

  patients.sort((a, b) => {
    if (a.completeness.filled !== b.completeness.filled) {
      return a.completeness.filled - b.completeness.filled;
    }
    return b.numbers.totalMinutes - a.numbers.totalMinutes;
  });

  return {
    patients,
    withoutContext: patients.filter((p) => p.completeness.state === "none").length,
    withFullContext: patients.filter((p) => p.completeness.state === "complete").length,
    casesCovered: sessions.length,
  };
}

export interface SavePatientNoteInput {
  patientKey: string;
  patientLabel: string | null;
  context: string;
  baseline: string;
  confounders: string;
  readWith: string;
}

/** Write one patient's context, encrypted at rest like every other free-text field. */
export async function savePatientNote(
  supabase: Client,
  userId: string,
  input: SavePatientNoteInput,
): Promise<void> {
  const { error } = await supabase.from("patient_context_notes").upsert(
    {
      user_id: userId,
      patient_key: input.patientKey,
      patient_label: input.patientLabel,
      context_sealed: seal(input.context.trim()),
      baseline_sealed: seal(input.baseline.trim()),
      confounders_sealed: seal(input.confounders.trim()),
      read_with_sealed: seal(input.readWith.trim()),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,patient_key" },
  );
  if (error) throw new Error(error.message);
}
