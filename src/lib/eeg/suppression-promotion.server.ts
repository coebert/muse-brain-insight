/**
 * Promotion store for the suppression model.
 *
 * A fit is only ever promoted when `crossValidate` says it clears the gate:
 * enough readings, enough independent cases, enough recorded suppression, and
 * a real held-out sensitivity gain that does not cost too much accuracy or
 * separation. Promotion writes an immutable version row and makes it the
 * active model for its lineage, so the rest of the app reads one agreed
 * calibration rather than refitting on every page load.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SuppressionFitReport, SuppressionModel } from "./suppression-model";

type Client = SupabaseClient<any, any, any>;

export interface PromotedSuppressionModel {
  id: string;
  lineage: string;
  version: number;
  model: SuppressionModel;
  sensitivityGain: number | null;
  maeGain: number | null;
  createdAt: string;
  note: string | null;
}

export interface PromotionOutcome {
  promoted: boolean;
  reason: string;
  active: PromotedSuppressionModel | null;
}

/** Stable fingerprint of the data a fit was trained on. */
export function fitDigest(fit: SuppressionFitReport): string {
  const c = fit.model;
  return [
    fit.lineage,
    fit.points,
    fit.cases,
    fit.suppressedPoints,
    c ? [c.intercept, c.bSr, c.bSqrtSr, c.bIndexDeficit].map((v) => v.toFixed(6)).join(",") : "none",
  ].join("|");
}

function toModel(row: Record<string, unknown>): PromotedSuppressionModel | null {
  const c = row["coefficients"] as Record<string, unknown> | null;
  if (!c) return null;
  const n = (k: string) => Number(c[k] ?? 0);
  return {
    id: String(row["id"]),
    lineage: String(row["lineage"]),
    version: Number(row["version"] ?? 1),
    model: {
      intercept: n("intercept"),
      bSr: n("bSr"),
      bSqrtSr: n("bSqrtSr"),
      bIndexDeficit: n("bIndexDeficit"),
      n: n("n"),
      cases: n("cases"),
    },
    sensitivityGain: row["sensitivity_gain"] == null ? null : Number(row["sensitivity_gain"]),
    maeGain: row["mae_gain"] == null ? null : Number(row["mae_gain"]),
    createdAt: String(row["created_at"] ?? ""),
    note: (row["note"] as string | null) ?? null,
  };
}

/** The calibration currently in force for a lineage, or null when none is. */
export async function loadActiveSuppressionModel(
  supabase: Client,
  userId: string,
  lineage: string,
): Promise<PromotedSuppressionModel | null> {
  const { data, error } = await supabase
    .from("suppression_model_versions")
    .select("id, lineage, version, coefficients, sensitivity_gain, mae_gain, created_at, note")
    .eq("user_id", userId)
    .eq("lineage", lineage)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as Record<string, unknown> | undefined;
  return row ? toModel(row) : null;
}

/**
 * Promote a cross-validated fit, if it earns it.
 *
 * Refuses a blocked fit outright, and refuses a re-promotion of a calibration
 * trained on identical data so repeated runs cannot inflate the version count.
 */
export async function promoteSuppressionFit(
  supabase: Client,
  userId: string,
  fit: SuppressionFitReport,
  note?: string,
): Promise<PromotionOutcome> {
  const active = await loadActiveSuppressionModel(supabase, userId, fit.lineage);
  if (!fit.promotable || !fit.model) {
    return {
      promoted: false,
      reason: fit.blockedBy ?? "the fit does not clear the gate",
      active,
    };
  }

  const digest = fitDigest(fit);
  const { data: existing, error: existingError } = await supabase
    .from("suppression_model_versions")
    .select("id, version, data_digest")
    .eq("user_id", userId)
    .eq("lineage", fit.lineage)
    .order("version", { ascending: false });
  if (existingError) throw new Error(existingError.message);
  const rows = (existing ?? []) as Record<string, unknown>[];
  if (rows.some((r) => r["data_digest"] === digest) && active) {
    return {
      promoted: false,
      reason: "this calibration is already active on the same readings",
      active,
    };
  }
  const version = Number(rows[0]?.["version"] ?? 0) + 1;

  const { error: clearError } = await supabase
    .from("suppression_model_versions")
    .update({ is_active: false })
    .eq("user_id", userId)
    .eq("lineage", fit.lineage)
    .eq("is_active", true);
  if (clearError) throw new Error(clearError.message);

  const { data: inserted, error } = await supabase
    .from("suppression_model_versions")
    .insert({
      user_id: userId,
      lineage: fit.lineage,
      version,
      coefficients: fit.model as unknown as Record<string, number>,
      training: {
        points: fit.points,
        cases: fit.cases,
        suppressedPoints: fit.suppressedPoints,
        folds: fit.folds,
      },
      metrics_before: fit.before as unknown as Record<string, unknown>,
      metrics_after: fit.after as unknown as Record<string, unknown>,
      sensitivity_gain: fit.sensitivityGain,
      mae_gain: fit.maeGain,
      is_active: true,
      data_digest: digest,
      note: note ?? null,
    })
    .select("id, lineage, version, coefficients, sensitivity_gain, mae_gain, created_at, note")
    .single();
  if (error) throw new Error(error.message);

  return {
    promoted: true,
    reason: `promoted as v${version} on ${fit.points.toLocaleString()} readings from ${fit.cases} cases`,
    active: toModel(inserted as unknown as Record<string, unknown>),
  };
}
