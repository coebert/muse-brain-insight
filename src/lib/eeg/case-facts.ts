/**
 * Structured, clinician-editable details drawn out of a free-text case
 * summary. These are the fields the AI normalises first and the clinician
 * confirms before any cross-case pattern mining runs on them.
 */
export interface CaseFacts {
  /** Operation, procedure or reason for sedation, in normalised wording. */
  procedure: string;
  urgency: "elective" | "emergency" | "unknown";
  comorbidities: string[];
  drugs: string[];
  intraoperativeEvents: string[];
  emergence: "normal" | "slow" | "agitated" | "not_applicable" | "unknown";
  postopIssues: string[];
  /** Free-form short facts that do not fit the fields above. */
  keyDetails: string[];
  riskFactors: string[];
}

export const EMPTY_CASE_FACTS: CaseFacts = {
  procedure: "",
  urgency: "unknown",
  comorbidities: [],
  drugs: [],
  intraoperativeEvents: [],
  emergence: "unknown",
  postopIssues: [],
  keyDetails: [],
  riskFactors: [],
};

export const URGENCY_OPTIONS: { value: CaseFacts["urgency"]; label: string }[] = [
  { value: "elective", label: "Elective" },
  { value: "emergency", label: "Emergency" },
  { value: "unknown", label: "Not stated" },
];

export const EMERGENCE_OPTIONS: { value: CaseFacts["emergence"]; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "slow", label: "Slow" },
  { value: "agitated", label: "Agitated / delirious" },
  { value: "not_applicable", label: "Not applicable" },
  { value: "unknown", label: "Not stated" },
];

export const FACT_LIST_FIELDS = [
  { key: "comorbidities", label: "Comorbidities" },
  { key: "drugs", label: "Drugs / regimen" },
  { key: "intraoperativeEvents", label: "Intraoperative / bedside events" },
  { key: "postopIssues", label: "Postoperative or later issues" },
  { key: "keyDetails", label: "Other key details" },
  { key: "riskFactors", label: "Risk factors" },
] as const satisfies readonly { key: keyof CaseFacts; label: string }[];

function strings(value: unknown, max = 10): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Coerce anything (AI reply or stored JSON) into a complete CaseFacts. */
export function normaliseFacts(raw: unknown): CaseFacts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const urgency = ["elective", "emergency", "unknown"].includes(String(r["urgency"]))
    ? (r["urgency"] as CaseFacts["urgency"])
    : "unknown";
  const emergence = ["normal", "slow", "agitated", "not_applicable", "unknown"].includes(
    String(r["emergence"]),
  )
    ? (r["emergence"] as CaseFacts["emergence"])
    : "unknown";
  return {
    procedure: typeof r["procedure"] === "string" ? r["procedure"].trim().slice(0, 200) : "",
    urgency,
    emergence,
    comorbidities: strings(r["comorbidities"]),
    drugs: strings(r["drugs"]),
    intraoperativeEvents: strings(r["intraoperativeEvents"]),
    postopIssues: strings(r["postopIssues"]),
    keyDetails: strings(r["keyDetails"]),
    riskFactors: strings(r["riskFactors"], 6),
  };
}

/** True when the clinician has nothing at all recorded for this case. */
export function factsAreEmpty(f: CaseFacts): boolean {
  return (
    !f.procedure &&
    f.urgency === "unknown" &&
    f.emergence === "unknown" &&
    !f.comorbidities.length &&
    !f.drugs.length &&
    !f.intraoperativeEvents.length &&
    !f.postopIssues.length &&
    !f.keyDetails.length &&
    !f.riskFactors.length
  );
}

export interface CaseFactsRecord {
  sessionId: string;
  caseCode: string;
  recordedAt: string;
  /** The clinician's own words, shown beside the fields for checking. */
  summaryExcerpt: string;
  facts: CaseFacts;
  confirmed: boolean;
  /** True when these fields came from the AI and have not been saved yet. */
  draft: boolean;
}
