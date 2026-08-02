import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildModelReliability, type ModelReliability } from "./reliability";

export type { ModelReliability } from "./reliability";

/** Precision/recall for one slice of alerts. */
export interface PerformanceBucket {
  key: string;
  label: string;
  /** Alerts the clinician confirmed. */
  truePositives: number;
  /** Alerts the clinician rejected. */
  falsePositives: number;
  /** Findings the clinician logged that the AI never raised. */
  falseNegatives: number;
  unsure: number;
  total: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface CalibrationBin {
  key: "low" | "moderate" | "high" | "unknown";
  label: string;
  /** Nominal probability the stated confidence implies. */
  predicted: number | null;
  /** Observed precision in this bin. */
  observed: number | null;
  correct: number;
  incorrect: number;
  count: number;
  /** observed − predicted; positive = under-confident. */
  gap: number | null;
}

export interface RejectionPoint {
  /** ISO date of the week start. */
  period: string;
  reviewed: number;
  incorrect: number;
  missed: number;
  /** incorrect / (correct + incorrect). */
  rejectionRate: number | null;
  precision: number | null;
  recall: number | null;
}

export interface ModelPerformance {
  windowDays: number;
  from: string;
  to: string;
  overall: PerformanceBucket;
  byCategory: PerformanceBucket[];
  bySeverity: PerformanceBucket[];
  byModel: PerformanceBucket[];
  calibration: CalibrationBin[];
  /** Weighted mean |observed − predicted| across confidence bins, 0–1. */
  expectedCalibrationError: number | null;
  rejectionTrend: RejectionPoint[];
  modelPrecisionTrend: { model: string; points: { period: string; precision: number | null; reviewed: number }[] }[];
  /** Claimed alert strength vs observed outcomes, per model version. */
  reliabilityByModel: ModelReliability[];
  topRejectionReasons: { reason: string; count: number }[];
  missedFindings: { title: string; category: string; reason: string | null; created_at: string }[];
}

interface RawRow {
  alert_category: string | null;
  alert_severity: string | null;
  alert_title: string | null;
  alert_confidence: string | null;
  verdict: string | null;
  reason: string | null;
  model_version: string | null;
  created_at: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  excessive_depth: "Excessive depth",
  inadequate_depth: "Inadequate depth",
  burst_suppression: "Burst suppression",
  seizure: "Seizure / ictal",
  hypoxic_injury: "Hypoxic injury",
  encephalopathy: "Encephalopathy",
  nociception: "Nociception",
  signal_quality: "Signal quality",
  other: "Other",
};

/** Nominal hit-rate each stated confidence level claims. */
const CONFIDENCE_PRIOR: Record<string, number> = { low: 0.4, moderate: 0.7, high: 0.9 };

function emptyBucket(key: string, label: string): PerformanceBucket {
  return {
    key,
    label,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    unsure: 0,
    total: 0,
    precision: null,
    recall: null,
    f1: null,
  };
}

function tally(b: PerformanceBucket, verdict: string) {
  if (verdict === "correct") b.truePositives += 1;
  else if (verdict === "incorrect") b.falsePositives += 1;
  else if (verdict === "missed") b.falseNegatives += 1;
  else b.unsure += 1;
  b.total += 1;
  const p = b.truePositives + b.falsePositives;
  const r = b.truePositives + b.falseNegatives;
  b.precision = p > 0 ? b.truePositives / p : null;
  b.recall = r > 0 ? b.truePositives / r : null;
  b.f1 =
    b.precision != null && b.recall != null && b.precision + b.recall > 0
      ? (2 * b.precision * b.recall) / (b.precision + b.recall)
      : null;
}

function group(rows: RawRow[], keyOf: (r: RawRow) => string, labelOf?: (k: string) => string) {
  const map = new Map<string, PerformanceBucket>();
  for (const r of rows) {
    const key = keyOf(r) || "unknown";
    let b = map.get(key);
    if (!b) {
      b = emptyBucket(key, labelOf ? labelOf(key) : key);
      map.set(key, b);
    }
    tally(b, r.verdict ?? "unsure");
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/** Monday of the ISO week containing the timestamp, as YYYY-MM-DD. */
function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export const getModelPerformance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { windowDays?: number } | undefined) => {
    const raw = Number(input?.windowDays ?? 90);
    const windowDays = [7, 30, 90, 365, 3650].includes(raw) ? raw : 90;
    return { windowDays };
  })
  .handler(async ({ data, context }): Promise<ModelPerformance> => {
    const to = new Date();
    const from = new Date(to.getTime() - data.windowDays * 86_400_000);

    const { data: rows, error } = await context.supabase
      .from("ai_alert_feedback")
      .select(
        "alert_category, alert_severity, alert_title, alert_confidence, verdict, reason, model_version, created_at",
      )
      .gte("created_at", from.toISOString())
      .order("created_at", { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);

    const list = (rows ?? []) as RawRow[];

    const overall = emptyBucket("all", "All alerts");
    for (const r of list) tally(overall, r.verdict ?? "unsure");

    // Calibration: stated confidence vs observed precision.
    const bins: CalibrationBin[] = (["high", "moderate", "low", "unknown"] as const).map((key) => ({
      key,
      label: key === "unknown" ? "Not recorded" : `${key[0]!.toUpperCase()}${key.slice(1)} confidence`,
      predicted: CONFIDENCE_PRIOR[key] ?? null,
      observed: null,
      correct: 0,
      incorrect: 0,
      count: 0,
      gap: null,
    }));
    for (const r of list) {
      if (r.verdict !== "correct" && r.verdict !== "incorrect") continue;
      const raw = (r.alert_confidence ?? "unknown").toLowerCase();
      const bin = bins.find((b) => b.key === raw) ?? bins[3]!;
      if (r.verdict === "correct") bin.correct += 1;
      else bin.incorrect += 1;
      bin.count += 1;
    }
    for (const b of bins) {
      b.observed = b.count > 0 ? b.correct / b.count : null;
      b.gap = b.observed != null && b.predicted != null ? b.observed - b.predicted : null;
    }
    const graded = bins.filter((b) => b.count > 0 && b.gap != null);
    const gradedTotal = graded.reduce((s, b) => s + b.count, 0);
    const expectedCalibrationError = gradedTotal
      ? graded.reduce((s, b) => s + (b.count / gradedTotal) * Math.abs(b.gap!), 0)
      : null;

    // Weekly rejection / precision / recall trend.
    const weekMap = new Map<string, PerformanceBucket>();
    const modelWeek = new Map<string, Map<string, PerformanceBucket>>();
    for (const r of list) {
      const w = weekStart(r.created_at);
      const b = weekMap.get(w) ?? emptyBucket(w, w);
      tally(b, r.verdict ?? "unsure");
      weekMap.set(w, b);

      const model = r.model_version || "unknown";
      const perModel = modelWeek.get(model) ?? new Map<string, PerformanceBucket>();
      const mb = perModel.get(w) ?? emptyBucket(w, w);
      tally(mb, r.verdict ?? "unsure");
      perModel.set(w, mb);
      modelWeek.set(model, perModel);
    }

    const rejectionTrend: RejectionPoint[] = [...weekMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, b]) => {
        const reviewed = b.truePositives + b.falsePositives;
        return {
          period,
          reviewed,
          incorrect: b.falsePositives,
          missed: b.falseNegatives,
          rejectionRate: reviewed > 0 ? b.falsePositives / reviewed : null,
          precision: b.precision,
          recall: b.recall,
        };
      });

    const reasonCounts = new Map<string, number>();
    for (const r of list) {
      if (r.verdict !== "incorrect") continue;
      const reason = (r.reason ?? "").trim();
      if (!reason) continue;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }

    return {
      windowDays: data.windowDays,
      from: from.toISOString(),
      to: to.toISOString(),
      overall,
      byCategory: group(
        list,
        (r) => r.alert_category ?? "other",
        (k) => CATEGORY_LABEL[k] ?? k.replace(/_/g, " "),
      ),
      bySeverity: group(list, (r) => r.alert_severity ?? "advisory"),
      byModel: group(list, (r) => r.model_version || "unknown"),
      calibration: bins,
      expectedCalibrationError,
      rejectionTrend,
      reliabilityByModel: buildModelReliability(list),
      modelPrecisionTrend: [...modelWeek.entries()]
        .map(([model, m]) => ({
          model,
          points: [...m.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([period, b]) => ({
              period,
              precision: b.precision,
              reviewed: b.truePositives + b.falsePositives,
            })),
        }))
        .sort((a, b) => b.points.length - a.points.length),
      topRejectionReasons: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      missedFindings: list
        .filter((r) => r.verdict === "missed")
        .slice(-12)
        .reverse()
        .map((r) => ({
          title: r.alert_title || "Missed finding",
          category: CATEGORY_LABEL[r.alert_category ?? "other"] ?? (r.alert_category ?? "other"),
          reason: r.reason,
          created_at: r.created_at,
        })),
    };
  });
