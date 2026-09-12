/**
 * Server-only side of the conscious/unconscious state pool: reads the stored
 * PhysioNet spectral epochs that carry a usable state label, grades the index
 * on them with whole-case holdout, and promotes a candidate only when the
 * held-out separation genuinely improves.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHENNU_LINEAGE } from "./chennu";
import { PHYSIONET_POWER_LINEAGE } from "./physionet";
import { DOSE1_LINEAGE } from "./sedation-icu";
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
export const MAX_POOL_EPOCHS = 80_000;
const PAGE = 1000;

/**
 * Collections whose intake is written specifically for responsiveness labels.
 * The pool is not limited to them: any stored epoch whose published label
 * collapses cleanly to responsive or unresponsive is graded.
 */
export const STATE_LINEAGES = [PHYSIONET_POWER_LINEAGE, CHENNU_LINEAGE];

/**
 * The two collections that carry genuine sedation-state labels in volume:
 * the Cambridge propofol volunteers and DOSE-I. Fitting on the pair alone
 * keeps the target behavioural rather than monitor-derived.
 */
export const SEDATION_SCOPE = `${CHENNU_LINEAGE},${DOSE1_LINEAGE}`;

/** A scope is one collection key, or several separated by commas. */
export function scopeLineages(scope?: string | null): string[] {
  return (scope ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface StateLineageCount {
  lineage: string;
  epochs: number;
  cases: number;
  responsive: number;
  unresponsive: number;
  /** How the model in force separates the two states within this collection. */
  separation: Separation;
  /** The collection's own published label words, commonest first. */
  labels: { label: string; count: number }[];
}

/**
 * A fit can be scoped to one collection, so a dataset with its own sedation
 * labels (Chennu) can be graded on its own terms rather than only pooled.
 */
export function stateLineageKey(lineage?: string | null): string {
  return lineage ? `${STATE_LINEAGE_KEY}:${lineage}` : STATE_LINEAGE_KEY;
}

export interface StatePoolSummary {
  epochs: number;
  cases: number;
  responsive: number;
  unresponsive: number;
  /** Stored labels that were dropped as neither clearly responsive nor not. */
  unusable: number;
  labels: { label: string; count: number }[];
  lineages: StateLineageCount[];
  /** How the current reference mapping separates the two states. */
  current: Separation;
  activeVersion: number | null;
}

/** Load every stored epoch carrying a label that means responsive or not. */
export async function loadStatePool(
  supabase: Client,
  userId: string,
  limit = MAX_POOL_EPOCHS,
  lineage?: string | null,
): Promise<{ points: StateEpoch[]; unusable: number; labels: Map<string, number> }> {
  const points: StateEpoch[] = [];
  const labels = new Map<string, number>();
  let unusable = 0;

  for (let from = 0; from < limit; from += PAGE) {
    let query = supabase
      .from("external_spectral_epochs")
      .select("case_ref, source_lineage, at_seconds, label, bands, sef95, suppression_ratio")
      .eq("user_id", userId)
      .not("label", "is", null);
    const keys = scopeLineages(lineage);
    if (keys.length === 1) query = query.eq("source_lineage", keys[0]!);
    else if (keys.length > 1) query = query.in("source_lineage", keys);
    const { data, error } = await query
      .order("source_lineage", { ascending: true })
      .order("case_ref", { ascending: true })
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
        caseRef: `${String(row["source_lineage"] ?? "?")}/${String(row["case_ref"] ?? "?")}`,
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

async function loadIncumbent(supabase: Client, userId: string, lineage?: string | null) {
  const { data } = await supabase
    .from("coebis_model_versions")
    .select("version, coefficients, is_active")
    .eq("user_id", userId)
    .eq("lineage_key", stateLineageKey(lineage))
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
  lineage?: string | null,
): Promise<StatePoolSummary> {
  const { points, unusable, labels } = await loadStatePool(
    supabase,
    userId,
    MAX_POOL_EPOCHS,
    lineage,
  );
  const incumbent = await loadIncumbent(supabase, userId, lineage);
  const model = incumbent.model ?? BASELINE_STATE_MODEL;
  const byLineage = new Map<string, StateEpoch[]>();
  for (const p of points) {
    const key = p.caseRef.split("/")[0] ?? "?";
    const list = byLineage.get(key);
    if (list) list.push(p);
    else byLineage.set(key, [p]);
  }
  return {
    epochs: points.length,
    cases: new Set(points.map((p) => p.caseRef)).size,
    responsive: points.filter((p) => p.state === "responsive").length,
    unresponsive: points.filter((p) => p.state === "unresponsive").length,
    unusable,
    labels: [...labels.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    lineages: [...byLineage.entries()]
      .map(([key, list]) => {
        const counts = new Map<string, number>();
        for (const p of list) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
        return {
          lineage: key,
          epochs: list.length,
          cases: new Set(list.map((p) => p.caseRef)).size,
          responsive: list.filter((p) => p.state === "responsive").length,
          unresponsive: list.filter((p) => p.state === "unresponsive").length,
          separation: separationOf(list, (f) => scoreState(model, f)),
          labels: [...counts.entries()]
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => b.count - a.count),
        };
      })
      .sort((a, b) => b.epochs - a.epochs),
    current: separationOf(points, (f) => scoreState(model, f)),
    activeVersion: incumbent.version,
  };

}

export interface StateFitResult extends StateFitReport {
  version: number | null;
  promoted: boolean;
  /** The collection the fit was scoped to, or null when the whole pool was used. */
  lineage: string | null;
}

/** Fit, grade and (only on a clear gain) promote the state-separation model. */
export async function runStateFit(
  supabase: Client,
  userId: string,
  lineage?: string | null,
): Promise<StateFitResult> {
  const scope = lineage ?? null;
  const { points } = await loadStatePool(supabase, userId, MAX_POOL_EPOCHS, scope);
  const incumbent = await loadIncumbent(supabase, userId, scope);
  const report = gradeStateFit(points);

  if (!report.model) {
    return { ...report, version: null, promoted: false, lineage: scope };
  }

  const version = incumbent.maxVersion + 1;
  // Model version rows are insert-protected by RLS; write them with the
  // privileged client, still scoped to this user's id.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as unknown as Client;

  const { error } = await admin.from("coebis_model_versions").upsert(
    {
      user_id: userId,
      lineage_key: stateLineageKey(scope),
      version,
      model_family: STATE_MODEL_FAMILY,
      coefficients: report.model as unknown as never,
      training: {
        epochs: report.epochs,
        cases: report.cases,
        responsive: report.responsive,
        unresponsive: report.unresponsive,
        folds: report.folds,
        scope: scope ?? "all labelled collections",
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
      .eq("lineage_key", stateLineageKey(scope))
      .eq("is_active", true)
      .neq("version", version);
  }

  return { ...report, version, promoted: report.promote, lineage: scope };
}
