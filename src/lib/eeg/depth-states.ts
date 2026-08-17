/**
 * Ordinal depth-of-anaesthesia states, derived from the reference monitor.
 *
 * Discrimination metrics (Pk, ROC) need an *ordered clinical state* rather than
 * a second continuous number. In the absence of a bedside observer scale
 * recorded at every reading, the transcribed commercial monitor is the best
 * available reference standard, and its published clinical bands are the
 * conventional cut-points: >85 awake, 65–85 sedated, 40–65 general anaesthesia,
 * <40 deep. A reference suppression ratio overrides the bands, because burst
 * suppression is a state in its own right regardless of the displayed number.
 *
 * The obvious caveat is that the reference index defines the labels, so the
 * reference monitor scores perfectly against them by construction. That row is
 * reported as a ceiling, not as evidence.
 */

export type DepthStateKey = "awake" | "sedated" | "anaesthesia" | "deep";

export interface DepthState {
  key: DepthStateKey;
  /** Larger = deeper. Consumed directly as the Pk rank. */
  rank: number;
  label: string;
}

export const DEPTH_STATES: DepthState[] = [
  { key: "awake", rank: 0, label: "Awake / very light" },
  { key: "sedated", rank: 1, label: "Sedated" },
  { key: "anaesthesia", rank: 2, label: "General anaesthesia" },
  { key: "deep", rank: 3, label: "Deep / burst suppression" },
];

const BY_KEY = new Map(DEPTH_STATES.map((s) => [s.key, s]));

export function depthState(key: DepthStateKey): DepthState {
  return BY_KEY.get(key)!;
}

/**
 * Label one reading from the reference monitor. `sr` is the monitor's own
 * suppression ratio in percent when it was transcribed.
 */
export function depthStateFromReference(bis: number, sr?: number | null): DepthState | null {
  if (!Number.isFinite(bis)) return null;
  if (sr != null && Number.isFinite(sr) && sr >= 10) return depthState("deep");
  if (bis >= 85) return depthState("awake");
  if (bis >= 65) return depthState("sedated");
  if (bis >= 40) return depthState("anaesthesia");
  return depthState("deep");
}

export interface DepthBoundary {
  key: string;
  label: string;
  description: string;
  /** True when the state falls on the "positive" (deeper) side. */
  positive: (state: DepthState) => boolean;
}

/**
 * The boundaries that change what a clinician does: is the patient still
 * awake, are they adequately anaesthetised, and are they too deep.
 */
export const DEPTH_BOUNDARIES: DepthBoundary[] = [
  {
    key: "awake-vs-sedated",
    label: "Awake vs sedated or deeper",
    description: "Would the index have caught a patient who was still awake?",
    positive: (s) => s.rank >= 1,
  },
  {
    key: "adequate-anaesthesia",
    label: "Adequate anaesthesia vs lighter",
    description: "Does the index separate surgical anaesthesia from light sedation?",
    positive: (s) => s.rank >= 2,
  },
  {
    key: "too-deep",
    label: "Too deep / burst suppression",
    description: "Does the index flag excessive depth before harm accrues?",
    positive: (s) => s.rank >= 3,
  },
];
