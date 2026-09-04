/**
 * BIS model: data loading, fitting and promotion store.
 *
 * Server-only. Reads every paired bedside reading the user holds, fits one
 * candidate per acquisition lineage against the recorded commercial BIS, and
 * grades it on held-out cases against what the app publishes today (the active
 * COEBIS model, or the raw index where no COEBIS version is in force). Only a
 * fit that clears the gate in `bis-model.ts` may be promoted, and a promotion
 * writes an immutable version row rather than overwriting anything.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  crossValidate,
  type BisFitReport,
  type BisMetrics,
  type BisModel,
  type BisSample,
} from "./bis-model";
import { predictCoebis, type CoebisModel, type CoebisTrainingPoint } from "./coebis-covariates";
import { modelFromRow } from "./coebis-refit.server";
import { loadTrainingMatrix } from "./coebis-training.server";
import { selectValidatedPoints } from "./coebis-refit";

type Client = SupabaseClient<any, any, any>;

export interface PromotedBisModel {
  id: string;
  lineage: string;
  version: number;
  model: BisModel;
  maeGain: number | null;
  correlationGain: number | null;
  createdAt: string;
  note: string | null;
  metricsBefore: BisMetrics | null;
  metricsAfter: BisMetrics | null;
  training: { points: number; cases: number; folds: number } | null;
}

export interface BisModelReport {
  /** One candidate fit per lineage, biggest first. */
  fits: BisFitReport[];
  /** Versions currently in force, keyed by lineage. */
  active: PromotedBisModel[];
  totalPoints: number;
  totalCases: number;
}

export interface BisPromotionOutcome {
  promoted: string[];
  skipped: { lineage: string; reason: string }[];
  active: PromotedBisModel[];
}

function toPromoted(row: Record<string, unknown>): PromotedBisModel | null {
  const coefficients = row["coefficients"] as number[] | null;
  const terms = row["terms"] as string[] | null;
  if (!coefficients || !terms) return null;
  const training = (row["training"] as { points: number; cases: number; folds: number } | null) ?? null;
  return {
    id: String(row["id"]),
    lineage: String(row["lineage"]),
    version: Number(row["version"] ?? 1),
    model: {
      lineage: String(row["lineage"]),
      terms,
      coefficients,
      n: Number(training?.points ?? 0),
      cases: Number(training?.cases ?? 0),
    },
    maeGain: row["mae_gain"] == null ? null : Number(row["mae_gain"]),
    correlationGain: row["correlation_gain"] == null ? null : Number(row["correlation_gain"]),
    createdAt: String(row["created_at"] ?? ""),
    note: (row["note"] as string | null) ?? null,
    metricsBefore: (row["metrics_before"] as BisMetrics | null) ?? null,
    metricsAfter: (row["metrics_after"] as BisMetrics | null) ?? null,
    training,
  };
}

const SELECT =
  "id, lineage, version, terms, coefficients, training, metrics_before, metrics_after, mae_gain, correlation_gain, created_at, note";

/** Every BIS model currently in force, one per lineage at most. */
export async function loadActiveBisModels(
  supabase: Client,
  userId: string,
): Promise<PromotedBisModel[]> {
  const { data, error } = await supabase
    .from("bis_model_versions")
    .select(SELECT)
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("version", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Record<string, unknown>[])
    .map(toPromoted)
    .filter((m): m is PromotedBisModel => m != null);
}

/** Turn validated COEBIS training points into BIS-model samples, per lineage. */
export function samplesByLineage(
  points: CoebisTrainingPoint[],
  incumbents: Map<string, CoebisModel | null>,
): Map<string, BisSample[]> {
  const out = new Map<string, BisSample[]>();
  for (const p of points) {
    const lineage = p.lineageKey ?? "unlabelled";
    const coebis = incumbents.get(lineage) ?? null;
    // The honest comparator is what the app publishes today on this reading.
    const baseline = coebis ? predictCoebis(coebis, p, false) : p.appIndex;
    const sample: BisSample = {
      caseRef: p.sessionId ?? "unfiled",
      lineage,
      bis: p.bis,
      appIndex: p.appIndex,
      appSef: p.appSef ?? null,
      appSr: p.appSr ?? null,
      baseline,
    };
    const list = out.get(lineage);
    if (list) list.push(sample);
    else out.set(lineage, [sample]);
  }
  return out;
}

export async function loadIncumbents(
  supabase: Client,
  userId: string,
): Promise<Map<string, CoebisModel | null>> {
  const { data } = await supabase
    .from("coebis_model_versions")
    .select("lineage_key, version, model_family, coefficients, is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("version", { ascending: false });
  const map = new Map<string, CoebisModel | null>();
  for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
    const key = String(row["lineage_key"]);
    if (!map.has(key)) map.set(key, modelFromRow(row));
  }
  return map;
}

/** Fit a candidate BIS model per lineage and grade it on held-out cases. */
export async function loadBisModelReport(
  supabase: Client,
  userId: string,
  limit = 200000,
): Promise<BisModelReport> {
  const matrix = await loadTrainingMatrix(supabase, limit, userId, 100000);
  const validated = selectValidatedPoints(matrix.points);
  const incumbents = await loadIncumbents(supabase, userId);
  const grouped = samplesByLineage(validated.used, incumbents);

  const fits = [...grouped.entries()]
    .map(([lineage, samples]) => crossValidate(samples, lineage))
    .sort((a, b) => b.points - a.points);

  return {
    fits,
    active: await loadActiveBisModels(supabase, userId),
    totalPoints: validated.used.length,
    totalCases: new Set(validated.used.map((p) => p.sessionId ?? "unfiled")).size,
  };
}

function digestOf(fit: BisFitReport): string {
  const c = fit.model?.coefficients ?? [];
  return [fit.lineage, fit.points, fit.cases, c.map((v) => v.toFixed(6)).join(",")].join("|");
}

/** Promote every candidate that clears the gate; record why the rest did not. */
export async function promoteBisFits(
  supabase: Client,
  userId: string,
  report: BisModelReport,
  note?: string,
): Promise<BisPromotionOutcome> {
  const promoted: string[] = [];
  const skipped: { lineage: string; reason: string }[] = [];

  for (const fit of report.fits) {
    if (!fit.promotable || !fit.model) {
      skipped.push({ lineage: fit.lineage, reason: fit.blockedBy ?? "does not clear the gate" });
      continue;
    }
    const digest = digestOf(fit);
    const { data: existing, error: existingError } = await supabase
      .from("bis_model_versions")
      .select("version, data_digest, is_active")
      .eq("user_id", userId)
      .eq("lineage", fit.lineage)
      .order("version", { ascending: false });
    if (existingError) throw new Error(existingError.message);
    const rows = (existing ?? []) as unknown as Record<string, unknown>[];
    if (rows.some((r) => r["data_digest"] === digest && r["is_active"])) {
      skipped.push({
        lineage: fit.lineage,
        reason: "this fit is already active on the same readings",
      });
      continue;
    }
    const version = Number(rows[0]?.["version"] ?? 0) + 1;

    const { error: clearError } = await supabase
      .from("bis_model_versions")
      .update({ is_active: false })
      .eq("user_id", userId)
      .eq("lineage", fit.lineage)
      .eq("is_active", true);
    if (clearError) throw new Error(clearError.message);

    const { error } = await supabase.from("bis_model_versions").insert({
      user_id: userId,
      lineage: fit.lineage,
      version,
      terms: fit.model.terms,
      coefficients: fit.model.coefficients,
      training: { points: fit.points, cases: fit.cases, folds: fit.folds },
      metrics_before: fit.before,
      metrics_after: fit.after,
      mae_gain: fit.maeGain,
      correlation_gain: fit.correlationGain,
      is_active: true,
      data_digest: digest,
      note: note ?? null,
    });
    if (error) throw new Error(error.message);
    promoted.push(`${fit.lineage} v${version}`);
  }

  return { promoted, skipped, active: await loadActiveBisModels(supabase, userId) };
}
