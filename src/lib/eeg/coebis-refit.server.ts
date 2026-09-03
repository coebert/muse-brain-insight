/**
 * Server-only execution of the scheduled COEBIS refit pipeline.
 *
 * The job is deliberately conservative: bounded work per run, a database lease
 * so two runs never overlap, per-lineage data digests so unchanged data is
 * skipped instead of re-versioned, and a paused state that every entry point
 * checks before doing anything.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadTrainingMatrix } from "./coebis-training.server";
import type { CoebisModel, CoebisTrainingPoint } from "./coebis-covariates";
import {
  MAX_LINEAGES_PER_RUN,
  planRefit,
  refitLineage,
  selectValidatedPoints,
  summariseRun,
  type LineageRefit,
} from "./coebis-refit";

type Client = SupabaseClient<any, any, any>;

export const JOB_KEY = "coebis_refit";
/** Owners handled in one scheduled run. */
export const MAX_USERS_PER_RUN = 3;
/** How long a run may hold the lease before another run may take it over. */
export const LEASE_SECONDS = 600;

export interface RefitRunReport {
  runId: string | null;
  userId: string;
  trigger: string;
  status: "completed" | "failed" | "skipped";
  validatedPoints: number;
  rejected: Record<string, number>;
  lineagesConsidered: number;
  lineagesRefitted: number;
  modelsPromoted: number;
  summary: string;
  detail: LineageRefitRecord[];
  error?: string;
}

export interface LineageRefitRecord {
  lineageKey: string;
  version: number | null;
  n: number;
  cases: number;
  promoted: boolean;
  reason: string;
  maeGain: number | null;
  before: LineageRefit["before"];
  after: LineageRefit["after"];
  beforeSource: LineageRefit["beforeSource"];
  folds: number;
}

function modelFromRow(row: Record<string, unknown> | null | undefined): CoebisModel | null {
  if (!row) return null;
  const c = (row["coefficients"] as Record<string, unknown> | null) ?? {};
  return {
    family: String(row["model_family"] ?? "covariate") as CoebisModel["family"],
    gain: Number(c["gain"] ?? 1),
    offset: Number(c["offset"] ?? 0),
    knots: Array.isArray(c["knots"]) ? (c["knots"] as CoebisModel["knots"]) : [],
    terms: Array.isArray(c["terms"]) ? (c["terms"] as CoebisModel["terms"]) : [],
    ceTerms: Array.isArray(c["ceTerms"]) ? (c["ceTerms"] as CoebisModel["ceTerms"]) : [],
    diagnostics: null,
    caseIntercepts: {},
    n: Number(c["n"] ?? 0),
    sessions: Number(c["sessions"] ?? 0),
  };
}

function coefficientsOf(model: CoebisModel): Record<string, unknown> {
  return {
    gain: model.gain,
    offset: model.offset,
    knots: model.knots,
    terms: model.terms,
    ceTerms: model.ceTerms,
    n: model.n,
    sessions: model.sessions,
  };
}

export interface JobState {
  status: string;
  pausedReason: string | null;
  leaseUntil: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

export async function readJobState(admin: Client): Promise<JobState | null> {
  const { data } = await admin
    .from("coebis_refit_state")
    .select("status, paused_reason, lease_until, last_run_at, last_error")
    .eq("job_key", JOB_KEY)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  return {
    status: String(row["status"] ?? "idle"),
    pausedReason: (row["paused_reason"] as string | null) ?? null,
    leaseUntil: (row["lease_until"] as string | null) ?? null,
    lastRunAt: (row["last_run_at"] as string | null) ?? null,
    lastError: (row["last_error"] as string | null) ?? null,
  };
}

/**
 * Single-flight lock: the update only matches when the job is not paused and
 * no live lease exists, so a second concurrent run gets no row back and exits.
 */
export async function acquireLease(admin: Client, holder: string): Promise<boolean> {
  const now = new Date();
  const { data, error } = await admin
    .from("coebis_refit_state")
    .update({
      status: "running",
      holder,
      lease_until: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("job_key", JOB_KEY)
    .neq("status", "paused")
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("job_key");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function releaseLease(
  admin: Client,
  patch: { lastError?: string | null; paused?: string | null } = {},
): Promise<void> {
  await admin
    .from("coebis_refit_state")
    .update({
      status: patch.paused ? "paused" : "idle",
      paused_reason: patch.paused ?? null,
      holder: null,
      lease_until: null,
      last_run_at: new Date().toISOString(),
      last_error: patch.lastError ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("job_key", JOB_KEY);
}

/** Owners whose newest paired reading postdates their last refit run. */
export async function selectDueUsers(admin: Client, max = MAX_USERS_PER_RUN): Promise<string[]> {
  const { data: recent, error } = await admin
    .from("bis_paired_points")
    .select("user_id, recorded_at")
    .order("recorded_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const latest = new Map<string, string>();
  for (const raw of (recent ?? []) as unknown as Record<string, unknown>[]) {
    const id = String(raw["user_id"]);
    if (!latest.has(id)) latest.set(id, String(raw["recorded_at"]));
  }
  if (!latest.size) return [];

  const { data: runs } = await admin
    .from("coebis_refit_runs")
    .select("user_id, started_at, status")
    .in("user_id", [...latest.keys()])
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(500);
  const lastRun = new Map<string, string>();
  for (const raw of (runs ?? []) as unknown as Record<string, unknown>[]) {
    const id = String(raw["user_id"]);
    if (!lastRun.has(id)) lastRun.set(id, String(raw["started_at"]));
  }

  return [...latest.entries()]
    .filter(([id, at]) => {
      const previous = lastRun.get(id);
      return !previous || new Date(at).getTime() > new Date(previous).getTime();
    })
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .slice(0, max)
    .map(([id]) => id);
}

/**
 * Refit one owner's models. Idempotent: a lineage whose validated data has not
 * changed since its newest version is skipped, and version inserts are keyed
 * on the data digest so a re-run cannot mint duplicates.
 */
export async function runRefitForUser(
  client: Client,
  userId: string,
  trigger: string,
): Promise<RefitRunReport> {
  const base: RefitRunReport = {
    runId: null,
    userId,
    trigger,
    status: "completed",
    validatedPoints: 0,
    rejected: {},
    lineagesConsidered: 0,
    lineagesRefitted: 0,
    modelsPromoted: 0,
    summary: "",
    detail: [],
  };

  const { data: runRow, error: runError } = await client
    .from("coebis_refit_runs")
    .insert({ user_id: userId, trigger, status: "running" })
    .select("id")
    .single();
  if (runError) throw new Error(runError.message);
  const runId = String((runRow as unknown as Record<string, unknown>)["id"]);
  base.runId = runId;

  try {
    const matrix = await loadTrainingMatrix(client, 5000, userId);
    const validated = selectValidatedPoints(matrix.points);
    base.validatedPoints = validated.used.length;
    base.rejected = validated.rejected;

    const { data: versionRows } = await client
      .from("coebis_model_versions")
      .select("lineage_key, version, data_digest, model_family, coefficients, is_active, created_at")
      .eq("user_id", userId)
      .order("version", { ascending: false });
    const rows = (versionRows ?? []) as unknown as Record<string, unknown>[];

    const lastDigests: Record<string, string | null> = {};
    const maxVersion = new Map<string, number>();
    const incumbents = new Map<string, CoebisModel | null>();
    for (const row of rows) {
      const key = String(row["lineage_key"]);
      if (!(key in lastDigests)) lastDigests[key] = String(row["data_digest"]);
      maxVersion.set(key, Math.max(maxVersion.get(key) ?? 0, Number(row["version"])));
      if (row["is_active"] && !incumbents.has(key)) incumbents.set(key, modelFromRow(row));
    }

    const plan = planRefit(validated.used, lastDigests, MAX_LINEAGES_PER_RUN);
    base.lineagesConsidered = plan.entries.length + plan.deferred.length + plan.skippedUnchanged.length;

    for (const entry of plan.entries) {
      const result = refitLineage(
        entry.lineageKey,
        entry.points,
        incumbents.get(entry.lineageKey) ?? null,
      );
      let version: number | null = null;

      if (result.model) {
        version = (maxVersion.get(entry.lineageKey) ?? 0) + 1;
        const { error: insertError } = await client
          .from("coebis_model_versions")
          .upsert(
            {
              user_id: userId,
              run_id: runId,
              lineage_key: entry.lineageKey,
              version,
              model_family: result.family,
              coefficients: coefficientsOf(result.model),
              training: {
                n: result.n,
                cases: result.cases,
                folds: result.folds,
                passRate: Number(validated.passRate.toFixed(3)),
              },
              metrics_before: { ...result.before, source: result.beforeSource },
              metrics_after: result.after,
              mae_gain: result.maeGain,
              promoted: result.promote,
              is_active: result.promote,
              reason: result.reason,
              data_digest: result.digest,
            },
            { onConflict: "user_id,lineage_key,data_digest", ignoreDuplicates: true },
          );
        if (insertError) throw new Error(insertError.message);

        if (result.promote) {
          await client
            .from("coebis_model_versions")
            .update({ is_active: false })
            .eq("user_id", userId)
            .eq("lineage_key", entry.lineageKey)
            .eq("is_active", true)
            .neq("version", version);
          base.modelsPromoted++;
        }
      }

      base.lineagesRefitted++;
      base.detail.push({
        lineageKey: entry.lineageKey,
        version,
        n: result.n,
        cases: result.cases,
        promoted: result.promote,
        reason: result.reason,
        maeGain: result.maeGain,
        before: result.before,
        after: result.after,
        beforeSource: result.beforeSource,
        folds: result.folds,
      });
    }

    base.summary = summariseRun(
      base.detail.map((d) => ({ ...d, promote: d.promoted }) as unknown as LineageRefit),
    );
    if (plan.deferred.length) {
      base.summary += ` ${plan.deferred.length} lineage(s) deferred to the next run.`;
    }
    if (plan.skippedUnchanged.length) {
      base.summary += ` ${plan.skippedUnchanged.length} unchanged since the last refit.`;
    }

    await client
      .from("coebis_refit_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        validated_points: base.validatedPoints,
        rejected: base.rejected,
        lineages_considered: base.lineagesConsidered,
        lineages_refitted: base.lineagesRefitted,
        models_promoted: base.modelsPromoted,
        summary: base.summary,
        detail: base.detail,
      })
      .eq("id", runId);
    return base;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await client
      .from("coebis_refit_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error: message })
      .eq("id", runId);
    return { ...base, status: "failed", error: message, summary: `Refit failed: ${message}` };
  }
}

export interface ScheduledRefitResult {
  ran: boolean;
  skipped?: string;
  users: number;
  reports: RefitRunReport[];
}

/** Entry point for the scheduled trigger. */
export async function runScheduledRefit(admin: Client): Promise<ScheduledRefitResult> {
  const state = await readJobState(admin);
  if (state?.status === "paused") {
    return { ran: false, skipped: `Job paused: ${state.pausedReason ?? "unknown reason"}`, users: 0, reports: [] };
  }
  const holder = `run-${Date.now()}`;
  if (!(await acquireLease(admin, holder))) {
    return { ran: false, skipped: "Another refit run holds the lease.", users: 0, reports: [] };
  }
  try {
    const users = await selectDueUsers(admin);
    const reports: RefitRunReport[] = [];
    for (const userId of users) {
      reports.push(await runRefitForUser(admin, userId, "scheduled"));
    }
    const failed = reports.find((r) => r.status === "failed");
    await releaseLease(admin, { lastError: failed?.error ?? null });
    return { ran: true, users: users.length, reports };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await releaseLease(admin, { lastError: message });
    throw err;
  }
}
