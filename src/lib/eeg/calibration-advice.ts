/**
 * Model calibration advice.
 *
 * Turns measured agreement rates (precision/recall/calibration by category,
 * severity and model version) into concrete, human-readable recommendations
 * for threshold and confidence-weighting adjustments.
 *
 * Pure functions — no I/O.
 */

import type {
  CalibrationBin,
  ModelPerformance,
  PerformanceBucket,
} from "./model-performance.functions";

export type AdviceKind =
  | "raise_threshold"
  | "lower_threshold"
  | "reweight_confidence"
  | "severity"
  | "model_version"
  | "collect_more";

export interface CalibrationRecommendation {
  id: string;
  kind: AdviceKind;
  scope: "category" | "severity" | "model" | "confidence" | "overall";
  /** What the recommendation applies to, e.g. "Seizure / ictal". */
  target: string;
  title: string;
  /** Plain-language rationale citing the measured agreement rate. */
  rationale: string;
  /** Concrete suggested change. */
  action: string;
  /** Suggested multiplier on alert confidence for this slice (1 = unchanged). */
  confidenceWeight: number | null;
  /** Suggested evidence bar for this slice. */
  evidenceBar: "relaxed" | "normal" | "raised" | "strict" | null;
  priority: "high" | "medium" | "low";
  /** Graded verdicts backing the recommendation. */
  sample: number;
  /** Observed agreement rate, 0–1. */
  agreement: number | null;
}

export interface CalibrationAdvice {
  recommendations: CalibrationRecommendation[];
  graded: number;
  underpowered: boolean;
  summary: string;
}

/** Minimum graded verdicts before a slice-level recommendation is offered. */
const MIN_SAMPLE = 6;
const LOW_AGREEMENT = 0.6;
const HIGH_AGREEMENT = 0.85;

function graded(b: PerformanceBucket): number {
  return b.truePositives + b.falsePositives;
}

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

/** Map an agreement rate to a suggested confidence multiplier (0.5–1.15). */
function weightFor(agreement: number): number {
  const w = 0.5 + agreement * 0.72;
  return Math.round(Math.min(1.15, Math.max(0.5, w)) * 100) / 100;
}

function categoryAdvice(b: PerformanceBucket): CalibrationRecommendation | null {
  const n = graded(b);
  const a = b.precision;
  if (a == null) return null;
  if (n < MIN_SAMPLE) {
    return {
      id: `cat-${b.key}-sample`,
      kind: "collect_more",
      scope: "category",
      target: b.label,
      title: `Grade more ${b.label.toLowerCase()} alerts`,
      rationale: `Only ${n} graded verdict${n === 1 ? "" : "s"} — agreement of ${pct(a)} is not yet reliable.`,
      action: "Hold current thresholds until at least 6 verdicts are recorded for this category.",
      confidenceWeight: null,
      evidenceBar: null,
      priority: "low",
      sample: n,
      agreement: a,
    };
  }
  if (a < LOW_AGREEMENT) {
    const strict = a < 0.4;
    return {
      id: `cat-${b.key}-raise`,
      kind: "raise_threshold",
      scope: "category",
      target: b.label,
      title: `Raise the evidence bar for ${b.label.toLowerCase()}`,
      rationale: `${b.falsePositives} of ${n} graded ${b.label.toLowerCase()} alerts were rejected (agreement ${pct(a)}).`,
      action: strict
        ? "Require strict evidence and withhold alerts below moderate confidence; step severity down one level."
        : "Require raised evidence and suppress low-confidence alerts in this category.",
      confidenceWeight: weightFor(a),
      evidenceBar: strict ? "strict" : "raised",
      priority: strict ? "high" : "medium",
      sample: n,
      agreement: a,
    };
  }
  if (a >= HIGH_AGREEMENT && b.recall != null && b.recall < 0.7 && b.falseNegatives > 0) {
    return {
      id: `cat-${b.key}-lower`,
      kind: "lower_threshold",
      scope: "category",
      target: b.label,
      title: `Lower the threshold for ${b.label.toLowerCase()}`,
      rationale: `Agreement is high (${pct(a)}) but ${b.falseNegatives} finding${
        b.falseNegatives === 1 ? " was" : "s were"
      } logged as missed (recall ${pct(b.recall)}).`,
      action: "Relax the evidence bar so borderline cases are surfaced, and keep confidence unweighted.",
      confidenceWeight: 1.1,
      evidenceBar: "relaxed",
      priority: "high",
      sample: n,
      agreement: a,
    };
  }
  if (a >= HIGH_AGREEMENT) {
    return {
      id: `cat-${b.key}-keep`,
      kind: "reweight_confidence",
      scope: "category",
      target: b.label,
      title: `Keep ${b.label.toLowerCase()} at full weight`,
      rationale: `Agreement is ${pct(a)} across ${n} graded verdicts.`,
      action: "No threshold change; keep confidence weighting at or near 1.0.",
      confidenceWeight: weightFor(a),
      evidenceBar: "normal",
      priority: "low",
      sample: n,
      agreement: a,
    };
  }
  return null;
}

function severityAdvice(b: PerformanceBucket): CalibrationRecommendation | null {
  const n = graded(b);
  const a = b.precision;
  if (a == null || n < MIN_SAMPLE) return null;
  const label = b.label.charAt(0).toUpperCase() + b.label.slice(1);
  if (a < LOW_AGREEMENT) {
    return {
      id: `sev-${b.key}-demote`,
      kind: "severity",
      scope: "severity",
      target: label,
      title: `Demote over-called ${b.label} alerts`,
      rationale: `${pct(a)} agreement across ${n} graded ${b.label} alerts.`,
      action:
        b.key === "critical"
          ? "Promote to critical only with high confidence; otherwise raise as a warning."
          : "Step this severity down one level unless confidence is high.",
      confidenceWeight: weightFor(a),
      evidenceBar: "raised",
      priority: b.key === "critical" ? "high" : "medium",
      sample: n,
      agreement: a,
    };
  }
  if (a >= HIGH_AGREEMENT && b.key !== "critical" && b.falseNegatives > 0) {
    return {
      id: `sev-${b.key}-promote`,
      kind: "severity",
      scope: "severity",
      target: label,
      title: `Allow promotion from ${b.label}`,
      rationale: `${pct(a)} agreement with ${b.falseNegatives} missed finding(s) at this level.`,
      action: "Permit a one-level severity promotion when evidence is strong.",
      confidenceWeight: 1.05,
      evidenceBar: "normal",
      priority: "medium",
      sample: n,
      agreement: a,
    };
  }
  return null;
}

function confidenceAdvice(bin: CalibrationBin): CalibrationRecommendation | null {
  if (bin.count < MIN_SAMPLE || bin.gap == null || bin.observed == null) return null;
  const gap = bin.gap;
  if (Math.abs(gap) < 0.12) return null;
  const over = gap < 0;
  const label = bin.label.replace(" confidence", "");
  return {
    id: `conf-${bin.key}`,
    kind: "reweight_confidence",
    scope: "confidence",
    target: label,
    title: over
      ? `Down-weight "${label.toLowerCase()}" confidence claims`
      : `Up-weight "${label.toLowerCase()}" confidence claims`,
    rationale: `Claimed ${pct(bin.predicted)} but observed ${pct(bin.observed)} across ${bin.count} graded alerts (${Math.abs(
      Math.round(gap * 100),
    )} pts ${over ? "over" : "under"}-confident).`,
    action: over
      ? `Multiply stated confidence by ~${weightFor(bin.observed).toFixed(2)} before display and alerting.`
      : `Allow this band to carry more weight (multiplier ~${Math.min(1.15, 1 + Math.abs(gap)).toFixed(2)}).`,
    confidenceWeight: over
      ? weightFor(bin.observed)
      : Math.round(Math.min(1.15, 1 + Math.abs(gap)) * 100) / 100,
    evidenceBar: over ? "raised" : "normal",
    priority: Math.abs(gap) >= 0.25 ? "high" : "medium",
    sample: bin.count,
    agreement: bin.observed,
  };
}

function modelAdvice(buckets: PerformanceBucket[]): CalibrationRecommendation[] {
  const usable = buckets.filter((b) => graded(b) >= MIN_SAMPLE && b.precision != null);
  if (usable.length < 2) return [];
  const sorted = [...usable].sort((a, b) => (b.precision ?? 0) - (a.precision ?? 0));
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  if ((best.precision ?? 0) - (worst.precision ?? 0) < 0.1) return [];
  return [
    {
      id: `model-${worst.key}`,
      kind: "model_version",
      scope: "model",
      target: worst.label,
      title: `Prefer ${best.label} over ${worst.label}`,
      rationale: `${best.label} agrees ${pct(best.precision)} (${graded(best)} graded) versus ${pct(
        worst.precision,
      )} for ${worst.label} (${graded(worst)} graded).`,
      action: `Route reviews to ${best.label}, or raise the evidence bar while ${worst.label} is in use.`,
      confidenceWeight: weightFor(worst.precision ?? 0),
      evidenceBar: "raised",
      priority: "medium",
      sample: graded(worst),
      agreement: worst.precision,
    },
  ];
}

const PRIORITY_ORDER: Record<CalibrationRecommendation["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function buildCalibrationAdvice(perf: ModelPerformance): CalibrationAdvice {
  const gradedTotal = graded(perf.overall);
  const recs: CalibrationRecommendation[] = [];

  for (const b of perf.byCategory) {
    const r = categoryAdvice(b);
    if (r) recs.push(r);
  }
  for (const b of perf.bySeverity) {
    const r = severityAdvice(b);
    if (r) recs.push(r);
  }
  for (const bin of perf.calibration) {
    const r = confidenceAdvice(bin);
    if (r) recs.push(r);
  }
  recs.push(...modelAdvice(perf.byModel));

  if (perf.expectedCalibrationError != null && perf.expectedCalibrationError >= 0.2) {
    recs.push({
      id: "overall-ece",
      kind: "reweight_confidence",
      scope: "overall",
      target: "All alerts",
      title: "Recalibrate stated confidence globally",
      rationale: `Mean gap between claimed confidence and observed hit rate is ${pct(
        perf.expectedCalibrationError,
      )}.`,
      action:
        "Apply the per-band multipliers below across all categories so displayed confidence matches observed agreement.",
      confidenceWeight: null,
      evidenceBar: null,
      priority: "high",
      sample: gradedTotal,
      agreement: perf.overall.precision,
    });
  }

  recs.sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      b.sample - a.sample ||
      (a.agreement ?? 1) - (b.agreement ?? 1),
  );

  const underpowered = gradedTotal < MIN_SAMPLE * 2;
  const actionable = recs.filter((r) => r.kind !== "collect_more" && r.priority !== "low").length;
  const summary = underpowered
    ? `Only ${gradedTotal} graded verdict${gradedTotal === 1 ? "" : "s"} in this window — recommendations are provisional.`
    : actionable === 0
      ? `Agreement is ${pct(perf.overall.precision)} across ${gradedTotal} graded verdicts; no threshold changes indicated.`
      : `${actionable} adjustment${actionable === 1 ? "" : "s"} suggested from ${gradedTotal} graded verdicts (overall agreement ${pct(
          perf.overall.precision,
        )}).`;

  return { recommendations: recs, graded: gradedTotal, underpowered, summary };
}