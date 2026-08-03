/**
 * Adaptive alert tuning.
 *
 * Turns clinician verdicts on past alerts into per-category thresholds and
 * confidence weighting that are applied to every subsequent AI review in a
 * session, so alerts a clinician keeps rejecting need stronger evidence and
 * alerts they confirm keep their weight.
 */

export type Confidence = "low" | "moderate" | "high";
export type Severity = "critical" | "warning" | "advisory";

export interface TuningFeedbackRow {
  alert_id: string | null;
  alert_category: string | null;
  verdict: string | null;
  reason: string | null;
  session_id?: string | null;
  created_at?: string | null;
}

export interface CategoryTuning {
  category: string;
  /** Weighted counts (this session's verdicts count double). */
  correct: number;
  incorrect: number;
  /** Laplace-smoothed share of past alerts judged correct, 0–1. */
  precision: number;
  /** Multiplier applied to alert confidence, 0.4–1.15. */
  confidenceWeight: number;
  /** Minimum confidence an alert of this category must reach to be shown. */
  minConfidence: Confidence;
  /** Evidence bar communicated to the model. */
  evidenceBar: "normal" | "raised" | "strict";
  /** Whether severity is stepped down one level. */
  demoteSeverity: boolean;
  /** Most cited reasons for rejecting this category. */
  reasons: string[];
}

export interface AlertTuning {
  categories: CategoryTuning[];
  /** Verdicts used, after session weighting. */
  sampleSize: number;
  updatedAt: string;
}

export interface AlertTuningEffect {
  category: string;
  precision: number;
  confidenceWeight: number;
  evidenceBar: CategoryTuning["evidenceBar"];
  /** Confidence before tuning, when tuning changed it. */
  originalConfidence?: Confidence | null;
  originalSeverity?: Severity | null;
  note: string;
}

const CONF_SCORE: Record<Confidence, number> = { low: 0.3, moderate: 0.62, high: 0.9 };
const SEV_ORDER: Severity[] = ["advisory", "warning", "critical"];

function scoreToConfidence(score: number): Confidence {
  if (score >= 0.78) return "high";
  if (score >= 0.45) return "moderate";
  return "low";
}

function confidenceAtLeast(value: Confidence, min: Confidence): boolean {
  return CONF_SCORE[value] >= CONF_SCORE[min];
}

/** Builds per-category tuning from clinician verdicts, weighting this session double. */
export function deriveAlertTuning(
  rows: TuningFeedbackRow[],
  sessionId?: string | null,
): AlertTuning {
  const byCategory = new Map<string, { correct: number; incorrect: number; reasons: string[] }>();
  let sampleSize = 0;

  for (const row of rows) {
    const category = row.alert_category ?? "other";
    const weight = sessionId && row.session_id === sessionId ? 2 : 1;
    const bucket = byCategory.get(category) ?? { correct: 0, incorrect: 0, reasons: [] };
    if (row.verdict === "correct") bucket.correct += weight;
    else if (row.verdict === "incorrect") {
      bucket.incorrect += weight;
      if (row.reason && bucket.reasons.length < 3) bucket.reasons.push(row.reason);
    } else {
      byCategory.set(category, bucket);
      continue;
    }
    sampleSize += weight;
    byCategory.set(category, bucket);
  }

  const categories: CategoryTuning[] = [];
  for (const [category, b] of byCategory) {
    const total = b.correct + b.incorrect;
    if (total === 0) continue;
    // Laplace smoothing keeps small samples from swinging the tuning hard.
    const precision = (b.correct + 1) / (total + 2);
    const confidenceWeight = Math.max(0.4, Math.min(1.15, 0.55 + precision * 0.65));

    let evidenceBar: CategoryTuning["evidenceBar"] = "normal";
    let minConfidence: Confidence = "low";
    let demoteSeverity = false;

    if (total >= 3 && precision < 0.35) {
      evidenceBar = "strict";
      minConfidence = "high";
      demoteSeverity = true;
    } else if (total >= 2 && precision < 0.5) {
      evidenceBar = "raised";
      minConfidence = "moderate";
      demoteSeverity = true;
    }

    categories.push({
      category,
      correct: b.correct,
      incorrect: b.incorrect,
      precision,
      confidenceWeight,
      minConfidence,
      evidenceBar,
      demoteSeverity,
      reasons: b.reasons,
    });
  }

  categories.sort((a, z) => a.precision - z.precision);
  return { categories, sampleSize, updatedAt: new Date().toISOString() };
}

/** Compact directive describing the tuning to the model before it drafts alerts. */
export function tuningPromptBlock(tuning: AlertTuning): string {
  if (!tuning.categories.length) return "No tuning yet — use your default evidential bar.";
  return tuning.categories
    .map((c) => {
      const bar =
        c.evidenceBar === "strict"
          ? "only raise with unambiguous numbers and state how the previous objection is overcome; cap severity below critical unless immediately unsafe"
          : c.evidenceBar === "raised"
            ? "raise only when the numbers are clear and address the stated objection"
            : "default evidential bar";
      const reasons = c.reasons.length ? ` Objections: ${c.reasons.join("; ")}.` : "";
      return `${c.category}: ${c.correct} correct / ${c.incorrect} incorrect, agreement ${(c.precision * 100).toFixed(0)}% → ${bar}.${reasons}`;
    })
    .join("\n");
}

export interface TunableAlert {
  id: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  tuning?: AlertTuningEffect | null;
}

/**
 * Applies tuning to a set of alerts: reweights confidence, steps down severity
 * for repeatedly rejected categories, and drops alerts that no longer clear the
 * category's confidence threshold.
 */
export function applyAlertTuning<T extends TunableAlert>(alerts: T[], tuning: AlertTuning): T[] {
  const index = new Map(tuning.categories.map((c) => [c.category, c]));
  const out: T[] = [];

  for (const alert of alerts) {
    const c = index.get(alert.category);
    if (!c) {
      out.push(alert);
      continue;
    }

    const originalConfidence = alert.confidence;
    const originalSeverity = alert.severity;
    const tunedConfidence = scoreToConfidence(CONF_SCORE[originalConfidence] * c.confidenceWeight);

    if (!confidenceAtLeast(tunedConfidence, c.minConfidence)) continue; // suppressed by tuning

    let severity = originalSeverity;
    if (c.demoteSeverity && severity !== "advisory") {
      const i = SEV_ORDER.indexOf(severity);
      severity = SEV_ORDER[Math.max(0, i - 1)] as Severity;
    }

    const changed = tunedConfidence !== originalConfidence || severity !== originalSeverity;
    const note = changed
      ? `Tuned from your feedback on ${alert.category.replace(/_/g, " ")} alerts (${Math.round(c.precision * 100)}% agreement over ${c.correct + c.incorrect} verdicts): ${
          severity !== originalSeverity ? `severity ${originalSeverity} → ${severity}` : ""
        }${severity !== originalSeverity && tunedConfidence !== originalConfidence ? ", " : ""}${
          tunedConfidence !== originalConfidence
            ? `confidence ${originalConfidence} → ${tunedConfidence}`
            : ""
        }.`
      : `Your feedback on ${alert.category.replace(/_/g, " ")} alerts (${Math.round(c.precision * 100)}% agreement) left this alert unchanged.`;

    out.push({
      ...alert,
      severity,
      confidence: tunedConfidence,
      tuning: {
        category: c.category,
        precision: c.precision,
        confidenceWeight: c.confidenceWeight,
        evidenceBar: c.evidenceBar,
        originalConfidence: originalConfidence === tunedConfidence ? null : originalConfidence,
        originalSeverity: originalSeverity === severity ? null : originalSeverity,
        note,
      },
    });
  }

  return out;
}

/** Human-readable one-liner for the panel header. */
export function tuningSummary(tuning: AlertTuning): string | null {
  if (!tuning.sampleSize) return null;
  const adjusted = tuning.categories.filter((c) => c.evidenceBar !== "normal");
  if (!adjusted.length)
    return `Tuned on ${tuning.sampleSize} of your verdicts — no category needed a higher bar.`;
  return `Tuned on ${tuning.sampleSize} of your verdicts — higher evidence bar for ${adjusted
    .map((c) => c.category.replace(/_/g, " "))
    .join(", ")}.`;
}
