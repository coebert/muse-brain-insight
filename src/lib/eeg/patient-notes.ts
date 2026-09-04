/**
 * Per-patient clinical context.
 *
 * A COEBIS number on its own says nothing about whether it should be believed:
 * the same index means different things in a frail 88-year-old on
 * dexmedetomidine and a 30-year-old on propofol alone. This module models the
 * short written context a clinician keeps beside each patient, and states
 * plainly what is still missing before the numbers can be read safely.
 */

/** The four things a reader needs before trusting a depth number for a patient. */
export const NOTE_FIELDS = [
  {
    key: "context",
    label: "Who this patient is",
    hint: "Age, comorbidity, why they are anaesthetised or sedated, anything that changes the baseline EEG.",
  },
  {
    key: "baseline",
    label: "What normal looks like for them",
    hint: "Their awake or pre-induction pattern, and the index range you have seen them sit at when settled.",
  },
  {
    key: "confounders",
    label: "What could mislead the number",
    hint: "Drugs with their own EEG signature, diathermy, shivering, poor contact, neurological disease, hypothermia.",
  },
  {
    key: "readWith",
    label: "How to read COEBIS here",
    hint: "The caveat you would say out loud when handing over: what to weigh the index against in this patient.",
  },
] as const;

export type NoteFieldKey = (typeof NOTE_FIELDS)[number]["key"];

export interface PatientContextNote {
  context: string;
  baseline: string;
  confounders: string;
  readWith: string;
  updatedAt: string | null;
}

export const EMPTY_NOTE: PatientContextNote = {
  context: "",
  baseline: "",
  confounders: "",
  readWith: "",
  updatedAt: null,
};

export interface PatientCaseSummary {
  sessionId: string;
  caseCode: string;
  startedAt: string;
  durationMinutes: number;
  meanSuppressionPct: number | null;
  maxSuppressionPct: number | null;
  suppressionMinutes: number;
  seizureAlerts: number;
  /** Median depth index recorded in that case, when epochs were scored. */
  medianIndex: number | null;
  minIndex: number | null;
  maxIndex: number | null;
}

export interface PatientNumbers {
  cases: number;
  totalMinutes: number;
  /** Median of the per-case median index — a rough centre for this patient. */
  medianIndex: number | null;
  lowestIndex: number | null;
  meanSuppressionPct: number | null;
  maxSuppressionPct: number | null;
  suppressionMinutes: number;
  seizureAlerts: number;
}

export type NoteState = "none" | "partial" | "complete";

export interface NoteCompleteness {
  filled: number;
  total: number;
  missing: string[];
  state: NoteState;
}

export interface PatientNoteCard {
  patientKey: string;
  label: string;
  /** True when the cases were tied to a named patient rather than standing alone. */
  linked: boolean;
  ageBand: string | null;
  sex: string | null;
  regimen: string | null;
  numbers: PatientNumbers;
  cases: PatientCaseSummary[];
  note: PatientContextNote;
  completeness: NoteCompleteness;
  /** What a reader must hold in mind, given what is and is not written down. */
  caveat: string;
}

const clean = (v: string | null | undefined) => (v ?? "").trim();

/** How much of the context is written down, and which parts are not. */
export function noteCompleteness(note: PatientContextNote): NoteCompleteness {
  const missing = NOTE_FIELDS.filter((f) => clean(note[f.key]).length === 0).map((f) => f.label);
  const filled = NOTE_FIELDS.length - missing.length;
  return {
    filled,
    total: NOTE_FIELDS.length,
    missing,
    state: filled === 0 ? "none" : filled === NOTE_FIELDS.length ? "complete" : "partial",
  };
}

/** The sentence shown beside the numbers so they are never read on their own. */
export function readingCaveat(numbers: PatientNumbers, note: PatientContextNote): string {
  const c = noteCompleteness(note);
  const written = clean(note.readWith);
  if (c.state === "none") {
    return "No context recorded for this patient, so these numbers cannot be interpreted — the same index means different things in different patients.";
  }
  const parts: string[] = [];
  if (written) parts.push(written);
  else parts.push("No reading caveat written yet for this patient.");
  if (numbers.suppressionMinutes > 0) {
    parts.push(
      `${numbers.suppressionMinutes} min of suppression recorded, which drags the index down independently of drug effect.`,
    );
  }
  if (numbers.seizureAlerts > 0) {
    parts.push(`${numbers.seizureAlerts} seizure-suspicion alert${numbers.seizureAlerts === 1 ? "" : "s"} — check the trace, not the index.`);
  }
  if (c.missing.length > 0) parts.push(`Still missing: ${c.missing.join("; ").toLowerCase()}.`);
  return parts.join(" ");
}

const median = (values: number[]): number | null => {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = nums.length / 2;
  const v =
    nums.length % 2 === 1 ? nums[Math.floor(mid)]! : (nums[mid - 1]! + nums[mid]!) / 2;
  return Number(v.toFixed(1));
};

/** Roll a patient's cases into the handful of numbers shown beside the note. */
export function summariseCases(cases: PatientCaseSummary[]): PatientNumbers {
  const suppressionValues = cases
    .map((c) => c.meanSuppressionPct)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const maxValues = cases
    .map((c) => c.maxSuppressionPct)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const lows = cases.map((c) => c.minIndex).filter((v): v is number => v != null);
  return {
    cases: cases.length,
    totalMinutes: Math.round(cases.reduce((sum, c) => sum + c.durationMinutes, 0)),
    medianIndex: median(cases.map((c) => c.medianIndex).filter((v): v is number => v != null)),
    lowestIndex: lows.length ? Number(Math.min(...lows).toFixed(1)) : null,
    meanSuppressionPct: suppressionValues.length
      ? Number((suppressionValues.reduce((a, b) => a + b, 0) / suppressionValues.length).toFixed(1))
      : null,
    maxSuppressionPct: maxValues.length ? Number(Math.max(...maxValues).toFixed(1)) : null,
    suppressionMinutes: Math.round(
      cases.reduce((sum, c) => sum + c.suppressionMinutes, 0),
    ),
    seizureAlerts: cases.reduce((sum, c) => sum + c.seizureAlerts, 0),
  };
}

/** Group key for a case: the linked patient when there is one, else the case itself. */
export function patientKeyFor(session: {
  id: string;
  patient_pseudonym: string | null;
  patient_link_id: string | null;
}): { key: string; linked: boolean } {
  if (session.patient_link_id) return { key: `patient:${session.patient_link_id}`, linked: true };
  if (session.patient_pseudonym) return { key: `pseudonym:${session.patient_pseudonym}`, linked: true };
  return { key: `case:${session.id}`, linked: false };
}
