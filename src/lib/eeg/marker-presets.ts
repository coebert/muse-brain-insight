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

/** Four one-tap markers surfaced on the bedside monitor for the active mode. */
export function quickMarkers(mode: "anaesthesia" | "icu"): string[] {
  return mode === "icu"
    ? ["Sedation hold", "Antiepileptic given", "Facial twitching noted", "Movement / artefact"]
    : ["Induction", "Surgical incision", "Propofol bolus", "Opioid bolus"];
}

/** Offsets offered when a marker is recorded after the event happened. */
export const BACKDATE_OFFSETS = [0, 30, 60, 120] as const;
