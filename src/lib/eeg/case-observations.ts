/**
 * Bedside ground truth: what the patient actually did, and what they were
 * actually given, stamped against the case clock.
 *
 * The depth index is currently graded against another monitor's number, which
 * caps it at that monitor's accuracy. Observed responsiveness (MOAA/S) is the
 * only target that is independent of any commercial index, and the drug record
 * is what lets an atypical agent be interpreted rather than misread. Both are
 * captured here in a shape a later fit can use directly.
 */

/** Modified Observer's Assessment of Alertness/Sedation, 5 (awake) to 0 (no response). */
export const MOAAS_SCALE = [
  { score: 5, short: "Awake", detail: "Responds readily to name spoken in a normal tone" },
  { score: 4, short: "Drowsy", detail: "Lethargic response to name spoken in a normal tone" },
  { score: 3, short: "Sluggish", detail: "Responds only after name is called loudly or repeatedly" },
  { score: 2, short: "Needs shake", detail: "Responds only after mild prodding or shaking" },
  { score: 1, short: "Deep", detail: "Responds only after painful trapezius squeeze" },
  { score: 0, short: "No response", detail: "No response to painful trapezius squeeze" },
] as const;

export type MoaasScore = (typeof MOAAS_SCALE)[number]["score"];

export function moaasLabel(score: number): string {
  return MOAAS_SCALE.find((s) => s.score === score)?.short ?? `MOAA/S ${score}`;
}

/** The stimulus the score was elicited with, kept so the score can be audited. */
export const STIMULI = ["none", "name", "loud", "shake", "trapezius"] as const;
export type Stimulus = (typeof STIMULI)[number];

export const STIMULUS_LABEL: Record<Stimulus, string> = {
  none: "No stimulus",
  name: "Name, normal voice",
  loud: "Name, loud/repeated",
  shake: "Mild prod or shake",
  trapezius: "Trapezius squeeze",
};

/** Units a bedside dose is realistically written in. */
export const DOSE_UNITS = ["mg", "mcg", "mg/kg", "mcg/kg", "mcg/kg/min", "mg/kg/h", "ml"] as const;
export type DoseUnit = (typeof DOSE_UNITS)[number];

export const ROUTES = ["iv-bolus", "iv-infusion", "inhaled", "other"] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTE_LABEL: Record<Route, string> = {
  "iv-bolus": "IV bolus",
  "iv-infusion": "IV infusion",
  inhaled: "Inhaled",
  other: "Other",
};

/** Agents that change the EEG in a way the index has to account for. */
export const COMMON_DRUGS = [
  "Propofol",
  "Ketamine",
  "Sevoflurane",
  "Desflurane",
  "Isoflurane",
  "Nitrous oxide",
  "Dexmedetomidine",
  "Midazolam",
  "Remifentanil",
  "Fentanyl",
  "Alfentanil",
  "Morphine",
  "Thiopentone",
  "Etomidate",
  "Rocuronium",
  "Atracurium",
  "Suxamethonium",
  "Lidocaine",
  "Magnesium",
  "Clonidine",
] as const;

/** Clinical events worth stamping at the bedside while they happen. */
export const EVENT_TYPES = [
  "seizure",
  "stimulus",
  "movement",
  "arousal",
  "artefact",
  "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABEL: Record<EventType, string> = {
  seizure: "Seizure-like",
  stimulus: "Stimulus applied",
  movement: "Movement",
  arousal: "Arousal",
  artefact: "Artefact",
  other: "Other event",
};

export const EVENT_DETAIL: Record<EventType, string> = {
  seizure: "Rhythmic or convulsive activity seen or suspected",
  stimulus: "Intubation, incision, voice or other deliberate stimulus",
  movement: "Patient moved, coughed or grimaced",
  arousal: "Patient appeared to lighten",
  artefact: "Diathermy, handling or other contamination",
  other: "Anything else worth revisiting on the trace",
};

export interface CaseObservation {
  id: string;
  caseCode: string;
  sessionId: string | null;
  kind: "responsiveness" | "drug" | "event" | "note";
  /** Seconds from the start of the recording. */
  atSeconds: number;
  moaas: number | null;
  stimulus: Stimulus | null;
  drugName: string | null;
  dose: number | null;
  doseUnit: string | null;
  route: string | null;
  eventType: EventType | null;
  note: string | null;
}

export interface ResponsivenessDraft {
  kind: "responsiveness";
  atSeconds: number;
  moaas: number;
  stimulus: Stimulus;
  note?: string | null;
}

export interface DrugDraft {
  kind: "drug";
  atSeconds: number;
  drugName: string;
  dose?: number | null;
  doseUnit?: string | null;
  route?: string | null;
  note?: string | null;
}

export interface EventDraft {
  kind: "event";
  atSeconds: number;
  eventType: EventType;
  note?: string | null;
}

/**
 * A free-text note pinned to a point on the case timeline. Written at the
 * bedside or added afterwards, when there was no time to type during the case.
 */
export interface TimelineNoteDraft {
  kind: "note";
  atSeconds: number;
  note: string;
}

export type ObservationDraft = ResponsivenessDraft | DrugDraft | EventDraft | TimelineNoteDraft;


export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Reject anything a later fit could not trust. A wrong dose or an out-of-range
 * score is worse than a missing one, because it is silently learned from.
 */
export function validateDraft(draft: ObservationDraft): ValidationResult {
  const errors: string[] = [];
  if (!Number.isFinite(draft.atSeconds) || draft.atSeconds < 0) {
    errors.push("The case time must be zero or more seconds.");
  }
  if (draft.kind === "responsiveness") {
    if (!Number.isInteger(draft.moaas) || draft.moaas < 0 || draft.moaas > 5) {
      errors.push("The responsiveness score must be a whole number from 0 to 5.");
    }
    if (!STIMULI.includes(draft.stimulus)) errors.push("Choose how the score was elicited.");
  } else if (draft.kind === "drug") {
    if (!draft.drugName.trim()) errors.push("Name the drug given.");
    if (draft.dose != null) {
      if (!Number.isFinite(draft.dose) || draft.dose <= 0) {
        errors.push("The dose must be a number greater than zero.");
      }
      if (!draft.doseUnit) errors.push("Give the dose a unit.");
    }
  } else {
    if (!EVENT_TYPES.includes(draft.eventType)) errors.push("Choose the kind of event.");
  }

  return { ok: errors.length === 0, errors };
}

/** Sorted oldest first, so a timeline always reads forwards. */
export function sortObservations(rows: CaseObservation[]): CaseObservation[] {
  return [...rows].sort((a, b) => a.atSeconds - b.atSeconds);
}

export interface ResponsivenessTransitions {
  /** First moment the patient stopped responding to voice (MOAA/S below 2). */
  lossOfResponsivenessAt: number | null;
  /** First moment after that at which they responded to voice again. */
  returnOfResponsivenessAt: number | null;
  /** Deepest (lowest) score recorded. */
  lowestScore: number | null;
  scoreCount: number;
}

/**
 * The two moments that make this dataset worth having: when responsiveness was
 * lost, and when it came back. Both are read from the recorded scores rather
 * than typed separately, so they cannot disagree with the scores.
 */
export function transitionsOf(rows: CaseObservation[]): ResponsivenessTransitions {
  const scores = sortObservations(rows).filter(
    (r) => r.kind === "responsiveness" && r.moaas != null,
  );
  let lor: number | null = null;
  let ror: number | null = null;
  let lowest: number | null = null;
  for (const row of scores) {
    const score = row.moaas!;
    lowest = lowest == null ? score : Math.min(lowest, score);
    if (lor == null && score < 2) lor = row.atSeconds;
    else if (lor != null && ror == null && score >= 2) ror = row.atSeconds;
  }
  return {
    lossOfResponsivenessAt: lor,
    returnOfResponsivenessAt: ror,
    lowestScore: lowest,
    scoreCount: scores.length,
  };
}

/** One line per drug: how many times it was given, and when it was first given. */
export interface DrugTally {
  drugName: string;
  doses: number;
  firstAtSeconds: number;
  lastAtSeconds: number;
}

export function drugTally(rows: CaseObservation[]): DrugTally[] {
  const byName = new Map<string, DrugTally>();
  for (const row of sortObservations(rows)) {
    if (row.kind !== "drug" || !row.drugName) continue;
    const existing = byName.get(row.drugName);
    if (existing) {
      existing.doses += 1;
      existing.lastAtSeconds = row.atSeconds;
    } else {
      byName.set(row.drugName, {
        drugName: row.drugName,
        doses: 1,
        firstAtSeconds: row.atSeconds,
        lastAtSeconds: row.atSeconds,
      });
    }
  }
  return [...byName.values()];
}

/**
 * What is still missing before this case can be used as a grading target.
 * Shown at the bedside while there is still time to capture it.
 */
export function captureGaps(rows: CaseObservation[]): string[] {
  const t = transitionsOf(rows);
  const gaps: string[] = [];
  if (t.scoreCount === 0) gaps.push("No responsiveness score recorded yet");
  if (t.lossOfResponsivenessAt == null) gaps.push("Loss of responsiveness not captured");
  if (t.lossOfResponsivenessAt != null && t.returnOfResponsivenessAt == null) {
    gaps.push("Return of responsiveness not captured yet");
  }
  if (!drugTally(rows).length) gaps.push("No drug recorded yet");
  return gaps;
}

export function describeObservation(row: CaseObservation): string {
  if (row.kind === "responsiveness") {
    const stim = row.stimulus ? STIMULUS_LABEL[row.stimulus] : null;
    return `MOAA/S ${row.moaas} · ${moaasLabel(row.moaas ?? -1)}${stim ? ` · ${stim}` : ""}`;
  }
  if (row.kind === "event") {
    const label = row.eventType ? EVENT_LABEL[row.eventType] : "Event";
    return `${label}${row.note ? ` · ${row.note}` : ""}`;
  }
  const dose = row.dose != null ? ` ${row.dose}${row.doseUnit ? ` ${row.doseUnit}` : ""}` : "";
  const route = row.route ? ` · ${ROUTE_LABEL[row.route as Route] ?? row.route}` : "";
  return `${row.drugName}${dose}${route}`;

}
