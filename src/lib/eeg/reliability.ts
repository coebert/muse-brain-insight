/**
 * Reliability analysis: how well an alert's *stated* confidence predicted the
 * clinician's verdict, broken down per model version and tracked over time.
 *
 * Pure functions — no I/O — so they stay out of the server-function module scope.
 */

export type ConfidenceKey = "low" | "moderate" | "high" | "unknown";

/** Nominal hit-rate each stated confidence level claims. */
export const CONFIDENCE_PRIOR: Record<string, number> = {
  low: 0.4,
  moderate: 0.7,
  high: 0.9,
};

export interface ReliabilityBin {
  key: ConfidenceKey;
  label: string;
  /** Nominal probability implied by the stated confidence. */
  predicted: number | null;
  /** Observed share confirmed correct. */
  observed: number | null;
  correct: number;
  incorrect: number;
  count: number;
  /** observed − predicted; positive = under-confident. */
  gap: number | null;
}

export interface ReliabilityPoint {
  /** ISO date of the week start. */
  period: string;
  /** Mean claimed strength of alerts graded that week, 0–1. */
  predicted: number | null;
  /** Observed hit rate that week, 0–1. */
  observed: number | null;
  graded: number;
}

export interface ModelReliability {
  model: string;
  graded: number;
  /** Mean claimed alert strength across graded alerts, 0–1. */
  meanPredicted: number | null;
  /** Observed hit rate across graded alerts, 0–1. */
  observed: number | null;
  /** observed − meanPredicted. */
  gap: number | null;
  /** Weighted mean |observed − predicted| across confidence bins, 0–1. */
  expectedCalibrationError: number | null;
  /** Mean squared error of claimed strength against outcome, 0–1 (lower is better). */
  brier: number | null;
  /** Share of graded alerts whose confidence was never recorded. */
  unlabelledShare: number;
  bins: ReliabilityBin[];
  trend: ReliabilityPoint[];
  verdict: "well-calibrated" | "over-confident" | "under-confident" | "insufficient-data";
}

export interface ReliabilityRow {
  alert_confidence: string | null;
  verdict: string | null;
  model_version: string | null;
  created_at: string;
}

const BIN_KEYS: ConfidenceKey[] = ["high", "moderate", "low", "unknown"];

function binLabel(key: ConfidenceKey): string {
  return key === "unknown" ? "Not recorded" : `${key[0]!.toUpperCase()}${key.slice(1)} confidence`;
}

function emptyBins(): ReliabilityBin[] {
  return BIN_KEYS.map((key) => ({
    key,
    label: binLabel(key),
    predicted: CONFIDENCE_PRIOR[key] ?? null,
    observed: null,
    correct: 0,
    incorrect: 0,
    count: 0,
    gap: null,
  }));
}

/** Monday of the ISO week containing the timestamp, as YYYY-MM-DD. */
function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function confidenceKey(raw: string | null): ConfidenceKey {
  const v = (raw ?? "unknown").toLowerCase();
  return (BIN_KEYS as string[]).includes(v) ? (v as ConfidenceKey) : "unknown";
}

function finishBins(bins: ReliabilityBin[]): number | null {
  for (const b of bins) {
    b.observed = b.count > 0 ? b.correct / b.count : null;
    b.gap = b.observed != null && b.predicted != null ? b.observed - b.predicted : null;
  }
  const graded = bins.filter((b) => b.count > 0 && b.gap != null);
  const total = graded.reduce((s, b) => s + b.count, 0);
  return total ? graded.reduce((s, b) => s + (b.count / total) * Math.abs(b.gap!), 0) : null;
}

/**
 * Build a per-model-version reliability breakdown from graded feedback rows.
 * Only `correct` / `incorrect` verdicts are scored.
 */
export function buildModelReliability(rows: ReliabilityRow[]): ModelReliability[] {
  const byModel = new Map<string, ReliabilityRow[]>();
  for (const r of rows) {
    if (r.verdict !== "correct" && r.verdict !== "incorrect") continue;
    const model = r.model_version || "unknown";
    const list = byModel.get(model) ?? [];
    list.push(r);
    byModel.set(model, list);
  }

  const out: ModelReliability[] = [];
  for (const [model, list] of byModel) {
    const bins = emptyBins();
    let predictedSum = 0;
    let predictedCount = 0;
    let brierSum = 0;
    let brierCount = 0;
    let correct = 0;
    let unlabelled = 0;

    const weeks = new Map<
      string,
      { predSum: number; predCount: number; correct: number; count: number }
    >();

    for (const r of list) {
      const key = confidenceKey(r.alert_confidence);
      const bin = bins.find((b) => b.key === key)!;
      const hit = r.verdict === "correct";
      if (hit) {
        bin.correct += 1;
        correct += 1;
      } else {
        bin.incorrect += 1;
      }
      bin.count += 1;
      if (key === "unknown") unlabelled += 1;

      const prior = CONFIDENCE_PRIOR[key];
      if (prior != null) {
        predictedSum += prior;
        predictedCount += 1;
        brierSum += (prior - (hit ? 1 : 0)) ** 2;
        brierCount += 1;
      }

      const w = weekStart(r.created_at);
      const cell = weeks.get(w) ?? { predSum: 0, predCount: 0, correct: 0, count: 0 };
      if (prior != null) {
        cell.predSum += prior;
        cell.predCount += 1;
      }
      if (hit) cell.correct += 1;
      cell.count += 1;
      weeks.set(w, cell);
    }

    const expectedCalibrationError = finishBins(bins);
    const meanPredicted = predictedCount ? predictedSum / predictedCount : null;
    const observed = list.length ? correct / list.length : null;
    const gap = meanPredicted != null && observed != null ? observed - meanPredicted : null;

    let verdict: ModelReliability["verdict"] = "insufficient-data";
    if (list.length >= 6 && gap != null) {
      if (Math.abs(gap) < 0.1) verdict = "well-calibrated";
      else verdict = gap < 0 ? "over-confident" : "under-confident";
    }

    out.push({
      model,
      graded: list.length,
      meanPredicted,
      observed,
      gap,
      expectedCalibrationError,
      brier: brierCount ? brierSum / brierCount : null,
      unlabelledShare: list.length ? unlabelled / list.length : 0,
      bins,
      trend: [...weeks.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([period, c]) => ({
          period,
          predicted: c.predCount ? c.predSum / c.predCount : null,
          observed: c.count ? c.correct / c.count : null,
          graded: c.count,
        })),
      verdict,
    });
  }

  return out.sort((a, b) => b.graded - a.graded);
}
