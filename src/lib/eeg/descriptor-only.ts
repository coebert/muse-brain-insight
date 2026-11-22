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
 * The policy fails closed: a missing, unknown, conflicting, bare-string or
 * incompletely evidenced context withholds every depth statement. Only a
 * context that carries acquisition identity and time, qualified reference and
 * calibration, and documented blockade absence for the whole recording can
 * support one — and even then the number stays an experimental research
 * descriptor, never a clinical depth.
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
  /** True whenever a depth-like statement is supported (never a clinical depth). */
  scoreEligible: boolean;
  /** An experimental protocol score is always research-only. */
  researchOnly: true;
  /**
   * Stable fingerprint of the case/interval evidence behind an eligible
   * verdict, or null when the policy withheld. A cached result may only be
   * reused when its stored fingerprint still matches the current evidence.
   */
  evidenceKey: string | null;
}

export const DESCRIPTOR_ONLY_TEMPLATES = {
  headline: "Signal descriptors only. No depth or awareness interpretation was produced.",
  depth:
    "Depth and awareness were not interpreted. The supplied context does not support a depth or awareness statement.",
  awareness: "Awareness cannot be assessed from this recording.",
  measured:
    "Measured signal descriptors are reported separately. No interpretation of depth, sedation or awareness was produced.",
  recommendation:
    "Review the signal descriptors and the independently recorded clinical context; any treatment decision is a clinician decision.",
  alertDetail: "Signal pattern only; it does not establish depth, sedation or awareness.",
  researchScore:
    "Experimental research protocol-state score. Not a clinical depth measurement and not for clinical use.",
  exportNote:
    "Experimental research descriptor. Not a clinical depth measurement and not for clinical use.",
} as const;

/** Wording shown wherever an experimental score is displayed. */
export const RESEARCH_SCORE_LABEL = "Research descriptor";
export const RESEARCH_SCORE_NOTE = DESCRIPTOR_ONLY_TEMPLATES.exportNote;

/**
 * Read a display's `descriptorOnly` flag, failing closed on omission.
 *
 * A component that forgets to pass the flag must not fall back to presenting a
 * depth number, target window or depth alert. Only an explicit `false` — the
 * policy's own verdict for a fully documented, eligible recording — allows
 * them; a missing, `undefined` or `null` flag withholds them.
 */
export function depthIsWithheld(descriptorOnly: boolean | undefined | null): boolean {
  return descriptorOnly !== false;
}

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

/** Any of these keys may carry the research/blockade context. */
const CONTEXT_KEYS = [
  "researchContext",
  "research_context",
  "blockadeContext",
  "blockade_context",
  "context",
  "blockade",
] as const;

const BLOCKADE_KEYS = [
  "blockade",
  "blockadeStatus",
  "blockade_status",
  "blockadeContext",
  "blockade_context",
] as const;
const SAFETY_GROUPS = [
  ["absenceDocumented", "absence_documented"],
  ["montageCompatible", "montage_compatible"],
  ["referenceCompatible", "reference_compatible"],
  ["calibrationCompatible", "calibration_compatible"],
  ["coverageAdequate", "coverage_adequate"],
] as const;

const QUALIFIED_REFERENCES: ReadonlySet<string> = new Set([
  "mastoid",
  "left mastoid",
  "right mastoid",
  "linked mastoids",
  "linked mastoid",
  "linked ears",
  "ear",
  "ears",
  "average",
  "common average",
  "cz",
  "vertex",
  "nose",
  "nose reference",
  "forehead",
  "afz",
  "tp9",
  "tp10",
]);

const MAX_CONTEXT_AGE_HOURS = 24;

function normalise(value: unknown): BlockadeContext {
  if (typeof value !== "string") return "unknown";
  const v = value.trim().toLowerCase();
  return (RECOGNISED.has(v) ? v : "unknown") as BlockadeContext;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readAlias(
  obj: Record<string, unknown>,
  keys: readonly string[],
): { present: boolean; value: unknown; conflict: boolean } {
  const present = keys.filter((key) => hasOwn(obj, key));
  if (!present.length) return { present: false, value: undefined, conflict: false };
  const values = present.map((key) => obj[key]);
  const distinct = new Set(values.map((value) => JSON.stringify(value ?? null)));
  return { present: true, value: values[0], conflict: distinct.size > 1 };
}

function readBoolean(
  obj: Record<string, unknown>,
  keys: readonly string[],
): { present: boolean; value: boolean; valid: boolean; conflict: boolean } {
  const alias = readAlias(obj, keys);
  if (!alias.present) return { present: false, value: false, valid: true, conflict: false };
  if (alias.conflict) return { present: true, value: false, valid: false, conflict: true };
  return {
    present: true,
    value: alias.value === true,
    valid: typeof alias.value === "boolean",
    conflict: false,
  };
}

function normaliseReference(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

function qualifiedReference(value: unknown): boolean {
  return QUALIFIED_REFERENCES.has(normaliseReference(value));
}

function parseTime(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function blocked(): DescriptorPolicy {
  return {
    context: "conflicting",
    descriptorOnly: true,
    reason: "the supplied context aliases disagree",
    scoreEligible: false,
    researchOnly: true,
    evidenceKey: null,
  };
}

function withhold(context: BlockadeContext, reason: string): DescriptorPolicy {
  return {
    context,
    descriptorOnly: true,
    reason,
    scoreEligible: false,
    researchOnly: true,
    evidenceKey: null,
  };
}

/** Keys that carry a research/blockade context on a stored row or case meta. */
const EVIDENCE_ALIAS_KEYS = [
  "researchContext",
  "research_context",
  "blockadeContext",
  "blockade_context",
] as const;

/**
 * Forward every research-context alias from a stored row or case metadata.
 *
 * Passing the containing object straight to `descriptorPolicy` is unsafe: a
 * case also has a clinical `context` field (e.g. "general_anaesthesia") that
 * the policy would read as a blockade context. This copies only the blockade
 * aliases — and keeps *both* spellings, so a conflicting pair stays
 * detectable instead of being collapsed with `??`.
 */
export function researchContextEvidence(source: unknown): Record<string, unknown> {
  const src = (source && typeof source === "object" ? source : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EVIDENCE_ALIAS_KEYS) {
    if (hasOwn(src, key)) out[key] = src[key];
  }
  return out;
}

/**
 * Read the context the caller supplied alongside a digest.
 *
 * All absent, unknown and conflicting contexts withhold a depth statement.
 * The only eligible shape carries acquisition identity/time, a qualified
 * reference and physical calibration, documented absence for every interval,
 * and coverage of the whole recording.
 */
export function descriptorPolicy(digest: unknown): DescriptorPolicy {
  const d = (digest && typeof digest === "object" ? digest : {}) as Record<string, unknown>;
  const supplied = CONTEXT_KEYS.filter((key) => hasOwn(d, key));
  if (!supplied.length) {
    return withhold("missing", "no research context was supplied; depth statements are withheld");
  }

  const values = supplied.map((key) => d[key]);
  const nonNull = values.filter((value) => value != null);
  if (!nonNull.length) {
    return withhold("missing", "the research context was withheld");
  }
  if (nonNull.length !== values.length) {
    // One alias withheld while another supplied a value is a contradiction.
    return blocked();
  }

  // Resolve every alias to a context word; disagreeing aliases are a conflict.
  const contexts = new Set(
    nonNull.map((value) =>
      typeof value === "string"
        ? normalise(value)
        : value && typeof value === "object"
          ? normalise(
              readAlias(value as Record<string, unknown>, BLOCKADE_KEYS).value ??
                (value as Record<string, unknown>)["status"],
            )
          : "unknown",
    ),
  );
  if (contexts.size > 1) return blocked();

  // Prefer the richest supplied shape, but never ignore a second object that
  // carries different evidence.
  const objects = nonNull.filter(
    (value): value is Record<string, unknown> => !!value && typeof value === "object",
  );
  if (objects.length > 1) {
    const evidence = new Set(objects.map((value) => JSON.stringify(evidenceOf(value))));
    if (evidence.size > 1) return blocked();
  }

  if (!objects.length) {
    const raw = nonNull[0];
    if (typeof raw !== "string") {
      return withhold("unknown", "the context is not readable");
    }
    return withhold(
      normalise(raw),
      "a bare context string cannot document blockade absence for each interval",
    );
  }

  return evaluateObject(objects[0]!, d);
}

function evidenceOf(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    ...BLOCKADE_KEYS,
    ...SAFETY_GROUPS.flat(),
    "status",
    "reference",
    "caseId",
    "case_id",
    "acquiredAt",
    "acquired_at",
    "intervals",
    "maxContextAgeHours",
    "max_context_age_hours",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (hasOwn(obj, key)) out[key] = obj[key];
  }
  return out;
}

/**
 * Fingerprint the case/interval evidence an eligible verdict rests on.
 *
 * The recording duration is deliberately excluded: it advances every epoch
 * and would invalidate an otherwise unchanged context on every refresh.
 */
function evidenceKeyOf(obj: Record<string, unknown>): string {
  return JSON.stringify(evidenceOf(obj));
}

function evaluateObject(
  obj: Record<string, unknown>,
  digest: Record<string, unknown>,
): DescriptorPolicy {
  const blockade = readAlias(obj, BLOCKADE_KEYS);
  if (blockade.conflict) return blocked();
  const context = normalise(blockade.value);
  if (context === "documented" || context === "suspected") {
    return withhold(context, "neuromuscular blockade is documented or suspected");
  }
  if (context !== "reported-absent") {
    return withhold(context, "absence of neuromuscular blockade is not independently documented");
  }

  const status = obj["status"];
  if (status != null) {
    if (typeof status !== "string") {
      return withhold("unknown", "the supplied status is not readable");
    }
    if (status.trim().toLowerCase() !== "research score") {
      return withhold("insufficient", `the supplied status is ${status.trim().toLowerCase()}`);
    }
  }

  // Every safety flag must be a real boolean when present. A string such as
  // "yes" is not evidence, and an unknown type fails closed.
  const flags: Record<string, boolean> = {};
  for (const group of SAFETY_GROUPS) {
    const alias = readBoolean(obj, group);
    if (!alias.present) continue;
    if (alias.conflict || !alias.valid) {
      return withhold("unknown", `the safety flag ${group[0]} is not a true/false value`);
    }
    flags[group[0]] = alias.value;
  }

  const intervals = obj["intervals"];
  const hasIntervals = Array.isArray(intervals) && intervals.length > 0;
  const intervalAbsence =
    hasIntervals &&
    (intervals as unknown[]).every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        ((item as Record<string, unknown>)["absenceDocumented"] === true ||
          (item as Record<string, unknown>)["absence_documented"] === true),
    );
  const absence = flags["absenceDocumented"] === true || intervalAbsence;
  const compatible =
    hasIntervals ||
    (flags["montageCompatible"] === true &&
      flags["referenceCompatible"] === true &&
      flags["calibrationCompatible"] === true);
  const coverage = flags["coverageAdequate"] === true;

  const caseId = obj["caseId"] ?? obj["case_id"];
  if (typeof caseId !== "string" || !caseId.trim()) {
    return withhold("insufficient", "the context carries no acquisition case identity");
  }
  const acquiredAt = parseTime(obj["acquiredAt"] ?? obj["acquired_at"]);
  if (!acquiredAt) {
    return withhold("insufficient", "the context carries no acquisition time");
  }
  const ageLimit = numberValue(obj["maxContextAgeHours"] ?? obj["max_context_age_hours"]);
  if (ageLimit != null && (ageLimit <= 0 || ageLimit > MAX_CONTEXT_AGE_HOURS)) {
    return withhold("insufficient", "the evidence lifetime exceeds the documented maximum");
  }
  const limitHours = ageLimit ?? MAX_CONTEXT_AGE_HOURS;

  if (!absence) {
    return withhold("insufficient", "a contributing interval lacks documented blockade absence");
  }
  if (!compatible) {
    return withhold("insufficient", "montage, reference or calibration is not compatible");
  }
  if (!hasIntervals && !qualifiedReference(obj["reference"])) {
    return withhold(
      "insufficient",
      "the documented reference is not a qualified acquisition reference",
    );
  }

  if (intervals !== undefined && intervals !== null) {
    if (!Array.isArray(intervals) || intervals.length === 0) {
      return withhold(
        "insufficient",
        "no documented blockade-absence interval covers the recording",
      );
    }
    const rows: { start: number; end: number; recordedAt: Date | null }[] = [];
    for (const item of intervals) {
      if (!item || typeof item !== "object") {
        return withhold("unknown", "a documented interval is not readable");
      }
      const row = item as Record<string, unknown>;
      const start = numberValue(row["start"]);
      const end = numberValue(row["end"]);
      if (start == null || end == null || start < 0 || end <= start) {
        return withhold("unknown", "a documented interval has an invalid time range");
      }
      const documented = row["absenceDocumented"] ?? row["absence_documented"];
      if (documented !== true) {
        return withhold(
          "insufficient",
          "a contributing interval lacks documented blockade absence",
        );
      }
      for (const flag of [
        "gap_before",
        "bolus_within_interval",
        "reversal_uncertain",
        "case_changed",
      ]) {
        if (hasOwn(row, flag) && typeof row[flag] !== "boolean") {
          return withhold("unknown", `the safety flag ${flag} is not a true/false value`);
        }
        if (row[flag] === true) {
          return withhold("insufficient", "a contributing interval cannot carry evidence");
        }
      }
      if (!qualifiedReference(row["reference"])) {
        return withhold("insufficient", "a documented interval has no qualified reference");
      }
      const calibration =
        typeof row["calibration"] === "string" ? row["calibration"].trim().toLowerCase() : "";
      if (!["uv", "µv", "μv", "microvolt", "microvolts"].includes(calibration)) {
        return withhold("insufficient", "a documented interval is not in physical microvolts");
      }
      rows.push({ start, end, recordedAt: parseTime(row["recordedAt"] ?? row["recorded_at"]) });
    }
    rows.sort((a, b) => a.start - b.start);
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i]!.start !== rows[i - 1]!.end) {
        return withhold("mixed", "contributing intervals are not contiguous");
      }
    }
    const duration = numberValue(digest["durationSeconds"]);
    if (duration == null) {
      return withhold(
        "insufficient",
        "the recording duration is unknown, so coverage cannot be matched",
      );
    }
    if (rows[0]!.start > 0 || rows[rows.length - 1]!.end < duration) {
      return withhold(
        "insufficient",
        "documented blockade absence does not cover the whole recording",
      );
    }
    for (const row of rows) {
      if (!row.recordedAt) {
        return withhold("insufficient", "a documented interval has no provenance time");
      }
      if (row.recordedAt.getTime() > acquiredAt.getTime()) {
        return withhold("insufficient", "documented evidence post-dates the recording");
      }
      const ageHours = (acquiredAt.getTime() - row.recordedAt.getTime()) / 3_600_000;
      if (ageHours > limitHours) {
        return withhold("expired", "documented evidence is stale for the recording");
      }
    }
  } else if (!coverage) {
    return withhold("insufficient", "usable EEG coverage is inadequate");
  }

  return {
    context: "reported-absent",
    descriptorOnly: false,
    reason: "documented blockade absence and compatible, adequate EEG",
    scoreEligible: true,
    researchOnly: true,
    evidenceKey: evidenceKeyOf(obj),
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

const MENTIONS_DEPTH =
  /\b(depth|sedat\w*|anaesthe\w*|anesthe\w*|awareness|conscious\w*|unconscious)\b/i;

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
export function descriptorOnlyText(text: unknown, fallback: string, strict = false): string {
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
