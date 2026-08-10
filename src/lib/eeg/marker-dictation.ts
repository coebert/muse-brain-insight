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
}

export interface MarkerDictationResult {
  markers: DictatedMarker[];
  /** Anything in the note that was not turned into a marker. */
  unmatched: string[];
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
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
      markers.push({
        label,
        atSeconds: at,
        timing:
          timing === "stated" || timing === "relative" || timing === "assumed-now"
            ? timing
            : "assumed-now",
        quote: clean(item["quote"], 120),
      });
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