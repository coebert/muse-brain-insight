import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AlertVerdict = "correct" | "incorrect" | "unsure";

export interface AlertFeedbackInput {
  alertId: string;
  category: string;
  severity: string;
  title: string;
  verdict: AlertVerdict;
  reason?: string | null;
  sessionId?: string | null;
  context?: string | null;
  /** Model that produced the alert, e.g. "openai/gpt-5.6-sol". */
  modelVersion?: string | null;
}

export interface AlertFeedbackRow {
  id: string;
  alert_id: string;
  alert_category: string;
  alert_severity: string;
  alert_title: string;
  verdict: AlertVerdict;
  reason: string | null;
  context: string | null;
  created_at: string;
}

const VERDICTS: AlertVerdict[] = ["correct", "incorrect", "unsure"];

export const submitAlertFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: AlertFeedbackInput) => {
    if (!input || typeof input.alertId !== "string" || !input.alertId.trim()) {
      throw new Error("An alert id is required.");
    }
    if (!VERDICTS.includes(input.verdict)) throw new Error("Invalid verdict.");
    const reason = (input.reason ?? "").toString().trim().slice(0, 1000);
    return { ...input, reason: reason || null };
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("ai_alert_feedback").insert({
      user_id: context.userId,
      session_id: data.sessionId ?? null,
      alert_id: data.alertId.slice(0, 120),
      alert_category: (data.category || "other").slice(0, 60),
      alert_severity: (data.severity || "advisory").slice(0, 30),
      alert_title: (data.title || "").slice(0, 200),
      verdict: data.verdict,
      reason: data.reason,
      context: data.context ?? null,
      model_version: (data.modelVersion ?? "unknown").toString().slice(0, 80),
      clinician_label: context.claims?.email
        ? String(context.claims.email).slice(0, 120)
        : null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listAlertFeedback = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AlertFeedbackRow[]> => {
    const { data, error } = await context.supabase
      .from("ai_alert_feedback")
      .select("id, alert_id, alert_category, alert_severity, alert_title, verdict, reason, context, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as AlertFeedbackRow[];
  });
export interface FeedbackBucket {
  key: string;
  label: string;
  correct: number;
  incorrect: number;
  unsure: number;
  total: number;
  /** correct / (correct + incorrect), 0–1, null when no graded feedback. */
  accuracy: number | null;
}

export interface FeedbackTrendPoint {
  /** ISO date (day or ISO week start) bucket. */
  date: string;
  correct: number;
  incorrect: number;
  unsure: number;
  total: number;
  accuracy: number | null;
}

export interface FeedbackAnalytics {
  totals: FeedbackBucket;
  byCategory: FeedbackBucket[];
  bySeverity: FeedbackBucket[];
  byClinician: FeedbackBucket[];
  byModel: FeedbackBucket[];
  /** Daily trend across the requested window. */
  trend: FeedbackTrendPoint[];
  /** Per-model daily accuracy, for model-version comparison over time. */
  modelTrend: { model: string; points: FeedbackTrendPoint[] }[];
  topIncorrectReasons: { reason: string; count: number }[];
  windowDays: number;
  from: string;
  to: string;
}

interface RawRow {
  alert_category: string | null;
  alert_severity: string | null;
  verdict: string | null;
  reason: string | null;
  model_version: string | null;
  clinician_label: string | null;
  user_id: string;
  created_at: string;
}

function emptyBucket(key: string, label: string): FeedbackBucket {
  return { key, label, correct: 0, incorrect: 0, unsure: 0, total: 0, accuracy: null };
}

function tally(bucket: FeedbackBucket, verdict: string) {
  if (verdict === "correct") bucket.correct += 1;
  else if (verdict === "incorrect") bucket.incorrect += 1;
  else bucket.unsure += 1;
  bucket.total += 1;
  const graded = bucket.correct + bucket.incorrect;
  bucket.accuracy = graded > 0 ? bucket.correct / graded : null;
}

function group(rows: RawRow[], keyOf: (r: RawRow) => string, labelOf?: (k: string) => string) {
  const map = new Map<string, FeedbackBucket>();
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

export const getFeedbackAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { windowDays?: number } | undefined) => {
    const raw = Number(input?.windowDays ?? 90);
    const windowDays = [7, 30, 90, 365, 3650].includes(raw) ? raw : 90;
    return { windowDays };
  })
  .handler(async ({ data, context }): Promise<FeedbackAnalytics> => {
    const to = new Date();
    const from = new Date(to.getTime() - data.windowDays * 86_400_000);

    const { data: rows, error } = await context.supabase
      .from("ai_alert_feedback")
      .select(
        "alert_category, alert_severity, verdict, reason, model_version, clinician_label, user_id, created_at",
      )
      .gte("created_at", from.toISOString())
      .order("created_at", { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);

    const list = (rows ?? []) as RawRow[];

    const totals = emptyBucket("all", "All feedback");
    for (const r of list) tally(totals, r.verdict ?? "unsure");

    const dayKey = (iso: string) => iso.slice(0, 10);
    const trendMap = new Map<string, FeedbackTrendPoint>();
    const modelTrendMap = new Map<string, Map<string, FeedbackTrendPoint>>();

    for (const r of list) {
      const d = dayKey(r.created_at);
      const point =
        trendMap.get(d) ?? { date: d, correct: 0, incorrect: 0, unsure: 0, total: 0, accuracy: null };
      tally(point as unknown as FeedbackBucket, r.verdict ?? "unsure");
      trendMap.set(d, point);

      const model = r.model_version || "unknown";
      const perModel = modelTrendMap.get(model) ?? new Map<string, FeedbackTrendPoint>();
      const mp =
        perModel.get(d) ?? { date: d, correct: 0, incorrect: 0, unsure: 0, total: 0, accuracy: null };
      tally(mp as unknown as FeedbackBucket, r.verdict ?? "unsure");
      perModel.set(d, mp);
      modelTrendMap.set(model, perModel);
    }

    const reasonCounts = new Map<string, number>();
    for (const r of list) {
      if ((r.verdict ?? "") !== "incorrect") continue;
      const reason = (r.reason ?? "").trim();
      if (!reason) continue;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }

    return {
      totals,
      byCategory: group(
        list,
        (r) => r.alert_category ?? "other",
        (k) => CATEGORY_LABEL[k] ?? k.replace(/_/g, " "),
      ),
      bySeverity: group(list, (r) => r.alert_severity ?? "advisory"),
      byClinician: group(
        list,
        (r) => r.clinician_label || r.user_id,
        (k) => (k.includes("@") ? k : `Clinician ${k.slice(0, 8)}`),
      ),
      byModel: group(list, (r) => r.model_version || "unknown"),
      trend: [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      modelTrend: [...modelTrendMap.entries()]
        .map(([model, m]) => ({
          model,
          points: [...m.values()].sort((a, b) => a.date.localeCompare(b.date)),
        }))
        .sort((a, b) => b.points.length - a.points.length),
      topIncorrectReasons: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      windowDays: data.windowDays,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  });
