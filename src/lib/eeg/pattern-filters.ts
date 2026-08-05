import type { CasePattern } from "@/lib/eeg/case-notes.functions";
import type { PatternFeedback } from "@/lib/eeg/pattern-feedback";

/** Broad clinical topic a proposed pattern is about, read from its wording. */
export type PatternType =
  | "seizure"
  | "suppression"
  | "depth"
  | "drug"
  | "quality"
  | "other";

export const PATTERN_TYPE_LABEL: Record<PatternType, string> = {
  seizure: "Seizure / ictal",
  suppression: "Burst suppression",
  depth: "Depth / emergence",
  drug: "Drugs & dosing",
  quality: "Signal quality",
  other: "Other",
};

const RULES: [PatternType, RegExp][] = [
  [/**/ "seizure", /seizur|ictal|epilept|spike|sharp|periodic discharge|status/i],
  ["suppression", /suppress|burst|isoelectric|bsr/i],
  ["depth", /depth|anaesthe|anesthe|sedat|emergen|awake|bis|openibis|sef|alpha ?power/i],
  ["drug", /propofol|remi|ketamine|alfentanil|bolus|infusion|tci|dose|dosing|opioid|midazolam|rocuronium/i],
  ["quality", /artefact|artifact|impedance|electrode|signal quality|sqi|noise|emg/i],
];

/** Classify a pattern for filtering; wording-based, so purely advisory. */
export function patternType(p: Pick<CasePattern, "title" | "detail">): PatternType {
  const text = `${p.title ?? ""} ${p.detail ?? ""}`;
  for (const [type, re] of RULES) if (re.test(text)) return type;
  return "other";
}

export type VerdictFilter = "all" | "undecided" | PatternFeedback["verdict"];

export interface PatternFilters {
  type: PatternType | "all";
  strength: CasePattern["strength"] | "all";
  caseCode: string;
  verdict: VerdictFilter;
}

export const DEFAULT_PATTERN_FILTERS: PatternFilters = {
  type: "all",
  strength: "all",
  caseCode: "all",
  verdict: "all",
};

/** Apply the review filters to one pattern given its current verdict. */
export function matchesFilters(
  p: CasePattern,
  feedback: PatternFeedback | undefined,
  f: PatternFilters,
): boolean {
  if (f.type !== "all" && patternType(p) !== f.type) return false;
  if (f.strength !== "all" && p.strength !== f.strength) return false;
  if (f.caseCode !== "all" && !(p.caseCodes ?? []).includes(f.caseCode)) return false;
  if (f.verdict === "undecided" && feedback) return false;
  if (f.verdict !== "all" && f.verdict !== "undecided" && feedback?.verdict !== f.verdict)
    return false;
  return true;
}

/** Every case code seen across the proposed patterns, sorted for the picker. */
export function cohortOptions(patterns: CasePattern[]): string[] {
  return [...new Set(patterns.flatMap((p) => p.caseCodes ?? []))].filter(Boolean).sort();
}