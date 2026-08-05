/** Clinician verdict on one AI-proposed cross-case pattern. */
export type PatternVerdict = "accepted" | "rejected" | "edited";

export interface PatternFeedback {
  patternKey: string;
  verdict: PatternVerdict;
  /** The pattern as the clinician wants it read (edited or original). */
  title: string;
  detail: string;
  suggestedAction: string;
  caseCodes: string[];
  /** Why it was accepted, rejected or reworded. */
  note: string;
  updatedAt: string;
}

/** Stable identity for a pattern across analysis runs, from its wording. */
export function patternKey(title: string): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

const VERDICTS: PatternVerdict[] = ["accepted", "rejected", "edited"];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Coerce untrusted stored/AI JSON into a safe feedback record. */
export function normaliseFeedback(raw: unknown, fallbackKey = ""): PatternFeedback {
  const o = (raw ?? {}) as Record<string, unknown>;
  const verdict = VERDICTS.includes(o["verdict"] as PatternVerdict)
    ? (o["verdict"] as PatternVerdict)
    : "accepted";
  return {
    patternKey: str(o["patternKey"]) || fallbackKey,
    verdict,
    title: str(o["title"]),
    detail: str(o["detail"]),
    suggestedAction: str(o["suggestedAction"]),
    caseCodes: Array.isArray(o["caseCodes"])
      ? (o["caseCodes"] as unknown[]).map(str).filter(Boolean).slice(0, 20)
      : [],
    note: str(o["note"]).slice(0, 600),
    updatedAt: str(o["updatedAt"]) || new Date().toISOString(),
  };
}

export const VERDICT_LABEL: Record<PatternVerdict, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  edited: "Edited",
};
