/**
 * Reactivity: what the EEG did around a marked moment.
 *
 * A depth index that cannot move when the patient is stimulated is not
 * measuring depth. Pairing each bedside mark (an applied stimulus, a
 * responsiveness score, a seizure-like event) with the trace either side of it
 * is the cheapest honest test of whether the index reacts, and the only way to
 * grade reactivity against something observed rather than against another
 * monitor's number.
 */

import type { CaseObservation } from "@/lib/eeg/case-observations";

/** The minimum a reading needs to be placed on the case clock. */
export interface ReactivityEpoch {
  /** Seconds since the start of the recording. */
  t: number;
  depth?: { index: number | null } | null;
  sef95?: number | null;
  suppressionRatio?: number | null;
  seizureScore?: number | null;
}

export interface ReactivityWindow {
  /** Seconds of trace taken either side of the mark. */
  seconds: number;
}

export const DEFAULT_REACTIVITY_WINDOW: ReactivityWindow = { seconds: 60 };

export interface ReactivityMeasure {
  before: number | null;
  after: number | null;
  change: number | null;
}

export interface ReactivityCase {
  observation: CaseObservation;
  /** Readings inside the window, kept so the moment can be drawn. */
  trace: { t: number; offset: number; index: number | null }[];
  depth: ReactivityMeasure;
  sef95: ReactivityMeasure;
  suppression: ReactivityMeasure;
  seizure: ReactivityMeasure;
  /** How many readings fell on each side; a one-sided window proves nothing. */
  beforeCount: number;
  afterCount: number;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function measure(
  before: ReactivityEpoch[],
  after: ReactivityEpoch[],
  pick: (e: ReactivityEpoch) => number | null | undefined,
): ReactivityMeasure {
  const value = (rows: ReactivityEpoch[]) =>
    mean(
      rows
        .map(pick)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    );
  const b = value(before);
  const a = value(after);
  return { before: b, after: a, change: b == null || a == null ? null : a - b };
}

/**
 * Everything measured around one marked moment. Returns null when there is no
 * trace on either side, rather than reporting a change from nothing.
 */
export function reactivityAt(
  observation: CaseObservation,
  epochs: ReactivityEpoch[],
  window: ReactivityWindow = DEFAULT_REACTIVITY_WINDOW,
): ReactivityCase | null {
  const at = observation.atSeconds;
  const span = Math.max(5, window.seconds);
  const inWindow = epochs.filter((e) => Math.abs(e.t - at) <= span);
  if (!inWindow.length) return null;
  const before = inWindow.filter((e) => e.t < at);
  const after = inWindow.filter((e) => e.t >= at);
  if (!before.length && !after.length) return null;
  return {
    observation,
    trace: inWindow
      .slice()
      .sort((x, y) => x.t - y.t)
      .map((e) => ({ t: e.t, offset: e.t - at, index: e.depth?.index ?? null })),
    depth: measure(before, after, (e) => e.depth?.index ?? null),
    sef95: measure(before, after, (e) => e.sef95 ?? null),
    suppression: measure(before, after, (e) => e.suppressionRatio ?? null),
    seizure: measure(before, after, (e) => e.seizureScore ?? null),
    beforeCount: before.length,
    afterCount: after.length,
  };
}

/**
 * The marks worth looking at: a deliberate stimulus, a responsiveness score
 * (which is itself a stimulus), and anything flagged as seizure-like or an
 * arousal. Drugs and artefact marks are excluded — they are not reactivity.
 */
export function reactivityMarks(rows: CaseObservation[]): CaseObservation[] {
  return rows
    .filter(
      (r) =>
        r.kind === "responsiveness" ||
        (r.kind === "event" &&
          (r.eventType === "stimulus" || r.eventType === "seizure" || r.eventType === "arousal")),
    )
    .sort((a, b) => a.atSeconds - b.atSeconds);
}

export function buildReactivity(
  rows: CaseObservation[],
  epochs: ReactivityEpoch[],
  window: ReactivityWindow = DEFAULT_REACTIVITY_WINDOW,
): ReactivityCase[] {
  return reactivityMarks(rows)
    .map((row) => reactivityAt(row, epochs, window))
    .filter((r): r is ReactivityCase => r !== null);
}

/**
 * A plain reading of the depth change, kept deliberately cautious: small moves
 * are noise on a two-channel frontal montage.
 */
export function describeChange(change: number | null, unit = "points"): string {
  if (change == null) return "not measurable";
  if (Math.abs(change) < 1) return "no change";
  return `${change > 0 ? "rose" : "fell"} ${Math.abs(change).toFixed(1)} ${unit}`;
}
