/**
 * Server-only side of the conscious/unconscious state pool: reads the stored
 * PhysioNet spectral epochs that carry a usable state label, grades the index
 * on them with whole-case holdout, and promotes a candidate only when the
 * held-out separation genuinely improves.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PHYSIONET_POWER_LINEAGE } from "./physionet";
import {
  BASELINE_STATE_MODEL,
  STATE_LINEAGE_KEY,
  STATE_MODEL_FAMILY,
  collapseState,
  featuresFrom,
  gradeStateFit,
  scoreState,
  separationOf,
  type Separation,
  type StateEpoch,
  type StateFitReport,
  type StateModel,
} from "./state-labels";

type Client = SupabaseClient<any, any, any>;

/** Ceiling on one pool read, so a request always finishes in its time slice. */
export const MAX_POOL_EPOCHS = 40_000;
const PAGE = 1000;

export interface StatePoolSummary {
  epochs: number;
  cases: number;
  responsive: number;
  unresponsive: number;
  /** Stored labels that were dropped as neither clearly responsive nor not. */
  unusable: number;
  labels: { label: string; count: number }[];
  /** How the current reference mapping separates the two states. */
  current: Separation;
  activeVersion: number | null;
}

/** Load every stored epoch of the PhysioNet power lineage that carries a label. */
export async function loadStatePool(
  supabase: Client,
  userId: string,
  limit = MAX_POOL_EPOCHS,
): Promise<{ points: StateEpoch[]; unusable: number; labels: Map<string, number> }> {
  const points: StateEpoch[] = [];
  const labels = new Map<string, number>();
  let unusable = 0;

  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("external_spectral_epochs")
      .select("case_ref, at_seconds, label, bands, sef95, suppression_ratio")
      .eq("user_id", userId)
      .eq("source_lineage", PHYSIONET_POWER_LINEAGE)
      .not("label", "is", null)
      .order("at_seconds", { ascending: true })
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];

    for (const row of rows) {
      const label = String(row["label"] ?? "");
      labels.set(label, (labels.get(label) ?? 0) + 1);
      const state = collapseState(label);
      if (!state) {
        unusable++;
        continue;
      }
      const bandsRow = (row["bands"] ?? {}) as Record<string, unknown>;
      const numberOf = (k: string) => Number(bandsRow[k] ?? 0) || 0;
      points.push({
        caseRef: String(row["case_ref"] ?? "?"),
        atSeconds: Number(row["at_seconds"] ?? 0),
        label,
        state,
        features: featuresFrom(
          {
            delta: numberOf("delta"),
            theta: numberOf("theta"),
            alpha: numberOf("alpha"),
            beta: numberOf("beta"),
            gamma: numberOf("gamma"),
          },
          row["sef95"] == null ? null : Number(row["sef95"]),
          row["suppression_ratio"] == null ? null : Number(row["suppression_ratio"]),
        ),
      });
    }
    if (rows.length < PAGE) break;
  }

  return { points, unusable, labels };
}

async function loadIncumbent(supabase: Client, userId: string) {
  const { data } = await supabase
    .from("coebis_model_versions")
    .select("version, coefficients, is_active")
    .eq("user_id", userId)
    .eq("lineage_key", STATE_LINEAGE_KEY)
    .order("version", { ascending: false })
    .limit(20);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const active = rows.find((r) => r["is_active"]) ?? null;
  const model = active
    ? ((active["coefficients"] as unknown as StateModel | null) ?? null)
    : null;
  return {
    model: model && Array.isArray(model.w) ? model : null,
    version: active ? Number(active["version"]) : null,
    maxVersion: rows.reduce((m, r) => Math.max(m, Number(r["version"] ?? 0)), 0),
  };
}

/** What the pool holds, and how well the model in force separates the states. */
export async function loadStateSummary(
  supabase: Client,
  userId: string,
): Promise<StatePoolSummary> {
  const { points, unusable, labels } = await loadStatePool(supabase, userId);
  const incumbent = await loadIncumbent(supabase, userId);
  const model = incumbent.model ?? BASELINE_STATE_MODEL;
  return {
    epochs: points.length,
    cases: new Set(points.map((p) => p.caseRef)).size,
    responsive: points.filter((p) => p.state === "responsive").length,
    unresponsive: points.filter((p) => p.state === "unresponsive").length,
    unusable,
    labels: [...labels.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    current: separationOf(points, (f) => scoreState(model, f)),
    activeVersion: incumbent.version,
  };
}

export interface StateFitResult extends StateFitReport {
  version: number | null;
  promoted: boolean;
}

/** Fit, grade and (only on a clear gain) promote the state-separation model. */
export async function runStateFit(
  supabase: Client,
  userId: string,
): Promise<StateFitResult> {
  const { points } = await loadStatePool(supabase, userId);
  const incumbent = await loadIncumbent(supabase, userId);
  const report = gradeStateFit(points);

  if (!report.model) {
    return { ...report, version: null, promoted: false };
  }

  const version = incumbent.maxVersion + 1;
  // Model version rows are insert-protected by RLS; write them with the
  // privileged client, still scoped to this user's id.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as unknown as Client;

  const { error } = await admin.from("coebis_model_versions").upsert(
    {
      user_id: userId,
      lineage_key: STATE_LINEAGE_KEY,
      version,
      model_family: STATE_MODEL_FAMILY,
      coefficients: report.model as unknown as never,
      training: {
        epochs: report.epochs,
        cases: report.cases,
        responsive: report.responsive,
        unresponsive: report.unresponsive,
        folds: report.folds,
        target: "responsiveness separation",
      } as unknown as never,
      metrics_before: report.before as unknown as never,
      metrics_after: report.after as unknown as never,
      mae_gain: null,
      promoted: report.promote,
      is_active: report.promote,
      reason: report.reason,
      data_digest: report.digest,
    },
    { onConflict: "user_id,lineage_key,data_digest", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);

  if (report.promote) {
    await admin
      .from("coebis_model_versions")
      .update({ is_active: false })
      .eq("user_id", userId)
      .eq("lineage_key", STATE_LINEAGE_KEY)
      .eq("is_active", true)
      .neq("version", version);
  }

  return { ...report, version, promoted: report.promote };
}
