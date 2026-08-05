/**
 * Contemporaneous event markers, grouped the way an anaesthetist thinks about
 * a case rather than alphabetically, so the right chip is found without reading.
 */
export interface MarkerGroup {
  key: string;
  label: string;
  markers: string[];
}

export const MARKER_GROUPS: MarkerGroup[] = [
  {
    key: "airway",
    label: "Airway & access",
    markers: ["Induction", "Laryngoscopy", "Intubation", "LMA inserted", "Extubation", "Line inserted"],
  },
  {
    key: "drugs",
    label: "Drugs",
    markers: [
      "Propofol bolus",
      "Ketamine bolus",
      "Rocuronium bolus",
      "Opioid bolus",
      "Vasopressor bolus",
      "Reversal given",
      "Antiepileptic given",
      "Sedation hold",
    ],
  },
  {
    key: "surgical",
    label: "Surgical & physiology",
    markers: [
      "Surgical incision",
      "Surgical stimulus",
      "Clamp on",
      "Clamp off",
      "Hypotension",
      "Desaturation",
      "Surgery finished",
    ],
  },
  {
    key: "neuro",
    label: "Neuro observations",
    markers: [
      "Facial twitching noted",
      "Movement / artefact",
      "Pupil change",
      "Shivering",
      "Emergence",
      "Patient responding",
    ],
  },
];

/** Offsets offered when a marker is recorded after the event happened. */
export const BACKDATE_OFFSETS = [0, 30, 60, 120] as const;

export type MarkerMode = "anaesthesia" | "icu";

/** Icon keys resolved to a lucide component by the quick-mark bar. */
export type MarkerIconKey =
  | "syringe"
  | "scissors"
  | "activity"
  | "zap"
  | "wind"
  | "eye"
  | "pause"
  | "alert";

/**
 * A one-tap marker template. `defaultBackdate` encodes how long after the
 * event a clinician realistically reaches the screen: drugs and stimuli are
 * marked as they happen, observations are noticed and marked a little later.
 */
export interface MarkerTemplate {
  /** Stable id, used for recency storage. */
  id: string;
  label: string;
  icon: MarkerIconKey;
  /** Seconds subtracted from the case clock when tapped. */
  defaultBackdate: number;
  tone: "marker" | "signal" | "caution" | "critical";
  modes: MarkerMode[];
}

export const MARKER_TEMPLATES: MarkerTemplate[] = [
  {
    id: "bolus",
    label: "Bolus given",
    icon: "syringe",
    defaultBackdate: 0,
    tone: "marker",
    modes: ["anaesthesia", "icu"],
  },
  {
    id: "propofol-bolus",
    label: "Propofol bolus",
    icon: "syringe",
    defaultBackdate: 0,
    tone: "marker",
    modes: ["anaesthesia", "icu"],
  },
  {
    id: "opioid-bolus",
    label: "Opioid bolus",
    icon: "syringe",
    defaultBackdate: 0,
    tone: "marker",
    modes: ["anaesthesia", "icu"],
  },
  {
    id: "relaxant-bolus",
    label: "Rocuronium bolus",
    icon: "syringe",
    defaultBackdate: 0,
    tone: "marker",
    modes: ["anaesthesia"],
  },
  {
    id: "induction",
    label: "Induction",
    icon: "activity",
    defaultBackdate: 0,
    tone: "signal",
    modes: ["anaesthesia"],
  },
  {
    id: "stimulus-start",
    label: "Stimulus started",
    icon: "scissors",
    defaultBackdate: 0,
    tone: "signal",
    modes: ["anaesthesia", "icu"],
  },
  {
    id: "stimulus-stop",
    label: "Stimulus stopped",
    icon: "scissors",
    defaultBackdate: 0,
    tone: "signal",
    modes: ["anaesthesia", "icu"],
  },
  {
    id: "incision",
    label: "Surgical incision",
    icon: "scissors",
    defaultBackdate: 0,
    tone: "signal",
    modes: ["anaesthesia"],
  },
  {
    id: "burst-suppression",
    label: "Burst suppression noted",
    icon: "alert",
    defaultBackdate: 30,
    tone: "caution",
    modes: ["anaesthesia", "icu"],
  },
  {
    id: "twitching",
    label: "Facial twitching noted",
    icon: "zap",
    defaultBackdate: 30,
    tone: "critical",
    modes: ["anaesthesia", "icu"],
  },
  {
    id: "movement",
    label: "Movement / artefact",
    icon: "wind",
    defaultBackdate: 30,
    tone: "caution",
    modes: ["anaesthesia", "icu"],
  },
  {
    id: "sedation-hold",
    label: "Sedation hold",
    icon: "pause",
    defaultBackdate: 0,
    tone: "signal",
    modes: ["icu"],
  },
  {
    id: "antiepileptic",
    label: "Antiepileptic given",
    icon: "syringe",
    defaultBackdate: 0,
    tone: "marker",
    modes: ["icu"],
  },
  {
    id: "responding",
    label: "Patient responding",
    icon: "eye",
    defaultBackdate: 30,
    tone: "signal",
    modes: ["icu"],
  },
  {
    id: "emergence",
    label: "Emergence",
    icon: "eye",
    defaultBackdate: 0,
    tone: "signal",
    modes: ["anaesthesia"],
  },
];

const STORAGE_KEY = "eeg.marker.recency.v1";
const QUICK_COUNT = 6;

function readRecency(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Bumps a template's use count so the bar reorders toward this clinician's habits. */
export function recordMarkerUse(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const counts = readRecency();
    counts[id] = (counts[id] ?? 0) + 1;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));
  } catch {
    // storage unavailable — recency is a nicety, never a blocker
  }
}

/**
 * Templates for the active mode, most-used first, capped to what fits one row.
 * Ties keep the declaration order so the bar is stable between cases.
 */
export function quickMarkerTemplates(mode: MarkerMode, limit = QUICK_COUNT): MarkerTemplate[] {
  const counts = readRecency();
  return MARKER_TEMPLATES.filter((t) => t.modes.includes(mode))
    .map((t, i) => ({ t, i, n: counts[t.id] ?? 0 }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, limit)
    .map((e) => e.t);
}

/** Labels only — kept for callers that just need the text list. */
export function quickMarkers(mode: MarkerMode): string[] {
  return quickMarkerTemplates(mode, 4).map((t) => t.label);
}
