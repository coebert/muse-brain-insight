/**
 * Descriptor-only policy for experimental depth research.
 *
 * The neuromuscular-blockade work showed that a model can label an awake,
 * paralysed volunteer as sedated. The app therefore treats any research
 * number as a *signal descriptor*, never as a current depth, a sedation level
 * or an awareness statement. This module is the single place that decides
 * whether the supplied context supports a depth-like statement, and the fixed
 * wording used when it does not.
 *
 * It is deliberately independent of the language model: the guard applies it
 * to the parsed output, so a prompt cannot talk its way past it.
 */

export type BlockadeContext =
  | "reported-absent"
  | "documented"
  | "suspected"
  | "unknown"
  | "omitted"
  | "conflicting"
  | "mixed"
  | "expired"
  | "insufficient"
  | "missing";

export interface DescriptorPolicy {
  context: BlockadeContext;
  /** True when depth/awareness prose must be replaced with the fixed templates. */
  descriptorOnly: boolean;
  reason: string;
}

export const DESCRIPTOR_ONLY_TEMPLATES = {
  headline: "Signal descriptors only. No depth or awareness interpretation was produced.",
  depth:
    "Depth and awareness were not interpreted. The supplied context does not support a depth or awareness statement.",
  awareness: "Awareness cannot be assessed from this recording.",
  recommendation:
    "Review the signal descriptors and the independently recorded clinical context; any treatment decision is a clinician decision.",
  alertDetail: "Signal pattern only; it does not establish depth, sedation or awareness.",
  exportNote:
    "Experimental research descriptor. Not a clinical depth measurement and not for clinical use.",
} as const;

/** Wording shown wherever an experimental score is displayed. */
export const RESEARCH_SCORE_LABEL = "Research descriptor";
export const RESEARCH_SCORE_NOTE = DESCRIPTOR_ONLY_TEMPLATES.exportNote;

const RECOGNISED: ReadonlySet<string> = new Set([
  "reported-absent",
  "documented",
  "suspected",
  "unknown",
  "omitted",
  "conflicting",
  "mixed",
  "expired",
  "insufficient",
]);

function normalise(value: unknown): BlockadeContext {
  if (typeof value !== "string") return "unknown";
  const v = value.trim().toLowerCase();
  return (RECOGNISED.has(v) ? v : "unknown") as BlockadeContext;
}

/**
 * Read the context the caller supplied alongside a digest.
 *
 * Only a context that documents blockade *absence* for the contributing
 * intervals, with compatible montage/reference/calibration and adequate
 * coverage, is treated as supporting a depth statement. Everything else —
 * including a bare "reported-absent" string with no provenance — withholds it.
 */
export function descriptorPolicy(digest: unknown): DescriptorPolicy {
  const d = (digest ?? {}) as Record<string, unknown>;
  const supplied = "researchContext" in d || "blockadeContext" in d || "context" in d;
  const raw = d["researchContext"] ?? d["blockadeContext"] ?? d["context"];
  if (!supplied) {
    // No research context was attached at all. The existing depth-index prose
    // is left alone; the universal assertion rules still remove patient-state
    // claims such as "the patient is unconscious".
    return {
      context: "missing",
      descriptorOnly: false,
      reason: "no research context was supplied",
    };
  }
  if (raw == null) {
    return {
      context: "missing",
      descriptorOnly: true,
      reason: "the research context was withheld",
    };
  }
  if (typeof raw === "string") {
    const context = normalise(raw);
    return {
      context,
      descriptorOnly: true,
      reason: "a bare context string cannot document blockade absence for each interval",
    };
  }
  if (typeof raw !== "object") {
    return { context: "unknown", descriptorOnly: true, reason: "the context is not readable" };
  }

  const o = raw as Record<string, unknown>;
  const context = normalise(o["blockade"] ?? o["status"] ?? "unknown");
  const status = typeof o["status"] === "string" ? o["status"].trim().toLowerCase() : "";
  const absence = o["absenceDocumented"] === true;
  const compatible =
    o["montageCompatible"] === true &&
    o["referenceCompatible"] === true &&
    o["calibrationCompatible"] === true;
  const coverage = o["coverageAdequate"] === true;

  if (context === "documented" || context === "suspected") {
    return {
      context,
      descriptorOnly: true,
      reason: "neuromuscular blockade is documented or suspected",
    };
  }
  if (context !== "reported-absent") {
    return {
      context,
      descriptorOnly: true,
      reason: "absence of neuromuscular blockade is not independently documented",
    };
  }
  if (!absence) {
    return {
      context: "insufficient",
      descriptorOnly: true,
      reason: "a contributing interval lacks documented blockade absence",
    };
  }
  if (!compatible) {
    return {
      context: "insufficient",
      descriptorOnly: true,
      reason: "montage, reference or calibration is not compatible",
    };
  }
  if (!coverage) {
    return {
      context: "insufficient",
      descriptorOnly: true,
      reason: "usable EEG coverage is inadequate",
    };
  }
  if (status && status !== "research score") {
    return {
      context: "insufficient",
      descriptorOnly: true,
      reason: `the supplied status is ${status}`,
    };
  }
  return {
    context,
    descriptorOnly: false,
    reason: "documented blockade absence and compatible, adequate EEG",
  };
}

const LIMITATION =
  /\b(cannot|can ?not|unable|not possible|does not|doesn't|no evidence|not assessed|not interpreted|not measured)\b/i;

const ASSERTIONS: RegExp[] = [
  /\b(?:the\s+)?patient\s+(?:is|was|are|were|appears?|seems?|remains?|looks?)\s+(?:now\s+|still\s+)?(?:unconscious|conscious|aware|asleep|sedated|anaestheti[sz]ed|anesthetized|anesthetised|deeply\s+sedated|adequately\s+sedated|comfortably\s+sedated|well\s+sedated|not\s+aware|unaware)\b/i,
  /\b(?:adequately|well|comfortably|sufficiently|deeply|lightly)\s+(?:sedated|anaestheti[sz]ed|anesthetized|anesthetised)\b/i,
  /\b(?:depth|sedation|anaesthesia|anesthesia|level\s+of\s+(?:sedation|anaesthesia|anesthesia))\s+(?:is|was|appears?|seems?|remains?|looks?)\s+(?:adequate|appropriate|sufficient|deep|light|stable|good|excessive|inadequate)\b/i,
  /\b(?:current|real[- ]time|live)\s+(?:depth|sedation|level\s+of\s+(?:sedation|anaesthesia|anesthesia))\b/i,
  /\b(?:no|without)\s+(?:awareness|recall)\b/i,
  /\b(?:unconscious|conscious)\s+(?:patient|state)\b/i,
  /\b(?:the\s+)?patient\s+(?:is|was|are|were)\s+(?:comfortable|settled|calm)\b/i,
];

const MENTIONS_DEPTH = /\b(depth|sedat\w*|anaesthe\w*|anesthe\w*|awareness|conscious\w*|unconscious)\b/i;

/** True when a sentence asserts a patient state, sedation adequacy or a current depth. */
export function impliesDepthOrSedation(sentence: string): boolean {
  return ASSERTIONS.some((pattern) => pattern.test(sentence));
}

function isLimitation(sentence: string): boolean {
  return LIMITATION.test(sentence) && !impliesDepthOrSedation(sentence);
}

/**
 * Replace unsupported depth/awareness prose sentence by sentence.
 *
 * ``strict`` is used when the context is withheld or missing: any sentence
 * that mentions depth, sedation or consciousness is replaced, not only one
 * that states a patient state outright.
 */
export function descriptorOnlyText(
  text: unknown,
  fallback: string,
  strict = false,
): string {
  if (typeof text !== "string") return fallback;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((sentence) => {
      if (impliesDepthOrSedation(sentence)) return false;
      if (strict && MENTIONS_DEPTH.test(sentence) && !isLimitation(sentence)) return false;
      return true;
    });
  return kept.length ? kept.join(" ") : fallback;
}

/**
 * Sanitise a cached or exported interpretation before it leaves the app.
 *
 * A summary written before the policy changed can still say "the patient is
 * unconscious". This walks the whole document so stale prose cannot survive
 * in an export just because it is nested.
 */
export function sanitizeDescriptorOnlyExport<T>(value: T, strict = true): T {
  if (typeof value === "string") {
    return descriptorOnlyText(value, DESCRIPTOR_ONLY_TEMPLATES.exportNote, strict) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDescriptorOnlyExport(item, strict)) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitizeDescriptorOnlyExport(item, strict),
      ]),
    ) as T;
  }
  return value;
}
