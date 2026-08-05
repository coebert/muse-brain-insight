/** Effect of prior accept/reject/edit verdicts on one pattern's confidence. */
export interface FeedbackInfluence {
  /** Whether prior feedback raised, lowered or left this pattern's confidence. */
  direction: "raised" | "lowered" | "unchanged" | "new";
  /** Strength this pattern would have carried without the feedback. */
  strengthWithoutFeedback: "emerging" | "moderate" | "strong" | "not proposed";
  /** One sentence saying which verdicts moved it and why. */
  because: string;
  /** The specific case details or EEG features that drove the shift. */
  drivers: string[];
  /** Titles of earlier judged patterns this one was weighed against. */
  relatedTitles: string[];
}

/** Session-wide account of how the feedback library shaped this run. */
export interface FeedbackImpact {
  accepted: number;
  rejected: number;
  edited: number;
  /** Plain-language summary of what the verdicts changed this time. */
  summary: string;
  /** Ideas suppressed because they repeat a rejected pattern. */
  suppressed: string[];
}

const DIRECTIONS: FeedbackInfluence["direction"][] = ["raised", "lowered", "unchanged", "new"];
const STRENGTHS: FeedbackInfluence["strengthWithoutFeedback"][] = [
  "emerging",
  "moderate",
  "strong",
  "not proposed",
];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function list(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : [];
}

/** Coerce the model's influence block into a safe, displayable shape. */
export function normaliseInfluence(raw: unknown): FeedbackInfluence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const direction = DIRECTIONS.includes(o["direction"] as FeedbackInfluence["direction"])
    ? (o["direction"] as FeedbackInfluence["direction"])
    : "new";
  const without = STRENGTHS.includes(
    o["strengthWithoutFeedback"] as FeedbackInfluence["strengthWithoutFeedback"],
  )
    ? (o["strengthWithoutFeedback"] as FeedbackInfluence["strengthWithoutFeedback"])
    : "not proposed";
  return {
    direction,
    strengthWithoutFeedback: without,
    because: str(o["because"]),
    drivers: list(o["drivers"], 4),
    relatedTitles: list(o["relatedTitles"], 3),
  };
}

/** Tally the clinician's verdict library alongside the model's account of it. */
export function countVerdicts(
  feedback: { verdict: "accepted" | "rejected" | "edited" }[],
  summary: string,
  suppressed: string[],
): FeedbackImpact {
  return {
    accepted: feedback.filter((f) => f.verdict === "accepted").length,
    rejected: feedback.filter((f) => f.verdict === "rejected").length,
    edited: feedback.filter((f) => f.verdict === "edited").length,
    summary: str(summary),
    suppressed: list(suppressed, 4),
  };
}

export const INFLUENCE_LABEL: Record<FeedbackInfluence["direction"], string> = {
  raised: "Confidence raised by your feedback",
  lowered: "Confidence lowered by your feedback",
  unchanged: "Unchanged by your feedback",
  new: "New — no earlier verdict applies",
};
