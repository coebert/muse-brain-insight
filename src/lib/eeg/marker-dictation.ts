/**
 * Free-text dictation turned into timestamped markers. The parsing itself is
 * done by the AI; everything here is the pure shaping the client and server
 * both rely on, so a model reply can never place a marker outside the case.
 */

export interface DictatedMarker {
  /** Short marker label, e.g. "Rocuronium 40 mg". */
  label: string;
  /** Seconds from the start of the recording. */
  atSeconds: number;
  /** How the time was arrived at, shown to the clinician before filing. */
  timing: "stated" | "relative" | "assumed-now";
  /** The words in the note this marker came from. */
  quote: string;
  /** Drug name in sentence case, when the event was a drug administration. */
  drug?: string;
  /** Numeric dose amount, when one was stated. */
  doseValue?: number;
  /** Dose unit exactly as clinicians write it, e.g. "mg", "mcg", "mg/kg/hr". */
  doseUnit?: string;
  /** Normalised route of administration, e.g. "IV", "IM", "inhaled". */
  route?: DrugRoute;
}

/** Routes the parser recognises; anything else is dropped rather than guessed. */
export const DRUG_ROUTES = [
  "IV",
  "IM",
  "SC",
  "PO",
  "SL",
  "PR",
  "IN",
  "inhaled",
  "nebulised",
  "topical",
  "epidural",
  "intrathecal",
  "infusion",
  "TCI",
] as const;

export type DrugRoute = (typeof DRUG_ROUTES)[number];

const ROUTE_LOOKUP = new Map<string, DrugRoute>();
for (const route of DRUG_ROUTES) ROUTE_LOOKUP.set(route.toLowerCase(), route);
for (const [written, route] of [
  ["intravenous", "IV"],
  ["i.v.", "IV"],
  ["iv bolus", "IV"],
  ["intramuscular", "IM"],
  ["i.m.", "IM"],
  ["subcut", "SC"],
  ["subcutaneous", "SC"],
  ["oral", "PO"],
  ["by mouth", "PO"],
  ["sublingual", "SL"],
  ["buccal", "SL"],
  ["rectal", "PR"],
  ["intranasal", "IN"],
  ["nasal", "IN"],
  ["inhalational", "inhaled"],
  ["volatile", "inhaled"],
  ["neb", "nebulised"],
  ["nebulized", "nebulised"],
  ["target controlled infusion", "TCI"],
  ["ivi", "infusion"],
] as const) {
  ROUTE_LOOKUP.set(written, route);
}

/** Map whatever the model wrote for a route onto the supported set. */
export function normaliseRoute(value: unknown): DrugRoute | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!key) return undefined;
  return ROUTE_LOOKUP.get(key) ?? ROUTE_LOOKUP.get(key.replace(/[.\s]/g, "")) ?? undefined;
}

/**
 * The single line filed onto the timeline: drug, dose and route read back the
 * way an anaesthetist writes them on a chart ("Rocuronium 40 mg IV").
 */
export function composeMarkerLabel(marker: DictatedMarker): string {
  if (!marker.drug) return marker.label;
  const dose =
    marker.doseValue !== undefined
      ? `${marker.doseValue}${marker.doseUnit ? ` ${marker.doseUnit}` : ""}`
      : "";
  return [marker.drug, dose, marker.route].filter(Boolean).join(" ").slice(0, 60);
}

export interface MarkerDictationResult {
  markers: DictatedMarker[];
  /** Anything in the note that was not turned into a marker. */
  unmatched: string[];
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function sentenceCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Coerce a model reply into markers that sit inside the recording. Anything
 * without a label is dropped; times are clamped to 0…elapsed.
 */
export function normaliseDictation(raw: unknown, elapsed: number): MarkerDictationResult {
  const source = (raw ?? {}) as { markers?: unknown; unmatched?: unknown };
  const limit = Math.max(0, Math.round(elapsed));
  const markers: DictatedMarker[] = [];

  if (Array.isArray(source.markers)) {
    const seen = new Set<string>();
    for (const entry of source.markers.slice(0, 20)) {
      const item = (entry ?? {}) as Record<string, unknown>;
      const label = clean(item["label"], 60);
      if (!label) continue;
      const seconds = Number(item["atSeconds"]);
      const at = Number.isFinite(seconds) ? Math.min(limit, Math.max(0, Math.round(seconds))) : limit;
      // The same event restated twice in one entry should mark the case once.
      const key = `${label.toLowerCase()}@${at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const timing = item["timing"];
      const drug = sentenceCase(clean(item["drug"], 40));
      const doseRaw = Number(item["doseValue"]);
      const doseValue =
        Number.isFinite(doseRaw) && doseRaw > 0 ? Math.round(doseRaw * 1000) / 1000 : undefined;
      const doseUnit = doseValue === undefined ? "" : clean(item["doseUnit"], 12);
      const route = normaliseRoute(item["route"]);
      const marker: DictatedMarker = {
        label,
        atSeconds: at,
        timing:
          timing === "stated" || timing === "relative" || timing === "assumed-now"
            ? timing
            : "assumed-now",
        quote: clean(item["quote"], 120),
        ...(drug ? { drug } : {}),
        ...(doseValue !== undefined ? { doseValue } : {}),
        ...(doseUnit ? { doseUnit } : {}),
        ...(route ? { route } : {}),
      };
      // Keep the filed label consistent with the structured fields.
      marker.label = composeMarkerLabel(marker);
      markers.push(marker);
    }
  }

  const unmatched = Array.isArray(source.unmatched)
    ? source.unmatched
        .map((u) => clean(u, 120))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  // Chronological order, and stable for events sharing a timestamp so the
  // proposal list reads in the order the clinician wrote them.
  const ordered = markers
    .map((marker, index) => ({ marker, index }))
    .sort((a, b) => a.marker.atSeconds - b.marker.atSeconds || a.index - b.index)
    .map((entry) => entry.marker);

  return { markers: ordered, unmatched };
}