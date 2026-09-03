import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { LineageRefitRecord } from "@/lib/eeg/coebis-refit.server";
import type { StoredCoefficients } from "@/lib/eeg/coebis-version-history";

export interface RefitRunRow {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  validatedPoints: number;
  rejected: Record<string, number>;
  lineagesConsidered: number;
  lineagesRefitted: number;
  modelsPromoted: number;
  summary: string | null;
  detail: LineageRefitRecord[];
  error: string | null;
}

export interface ModelVersionRow {
  id: string;
  lineageKey: string;
  version: number;
  modelFamily: string;
  promoted: boolean;
  isActive: boolean;
  reason: string | null;
  maeGain: number | null;
  createdAt: string;
  /** Run that produced this version, so history ties back to the job log. */
  runId: string | null;
  /** Fingerprint of the exact training set, so an unchanged fit is provable. */
  dataDigest: string;
  /** Fitted weights as stored, for the audit trail and version-to-version diff. */
  coefficients: StoredCoefficients;
  training: {
    n?: number;
    cases?: number;
    folds?: number;
    passRate?: number;
    lineageKey?: string;
    sessions?: number;
    firstReadingAt?: string | null;
    lastReadingAt?: string | null;
  };
  before: {
    mae?: number | null;
    bias?: number | null;
    ccc?: number | null;
    n?: number;
    source?: string;
  };
  after: { mae?: number | null; bias?: number | null; ccc?: number | null; n?: number };
}

export interface LineageHistory {
  lineageKey: string;
  activeVersion: number | null;
  versions: ModelVersionRow[];
  /** Newest version's before/after, i.e. the most recent refit for the lineage. */
  latest: ModelVersionRow | null;
}

export interface RefitOverview {
  runs: RefitRunRow[];
  lineages: LineageHistory[];
  lastRunAt: string | null;
}

function mapVersion(row: Record<string, unknown>): ModelVersionRow {
  return {
    id: String(row["id"]),
    lineageKey: String(row["lineage_key"]),
    version: Number(row["version"]),
    modelFamily: String(row["model_family"] ?? "covariate"),
    promoted: Boolean(row["promoted"]),
    isActive: Boolean(row["is_active"]),
    reason: (row["reason"] as string | null) ?? null,
    maeGain: row["mae_gain"] == null ? null : Number(row["mae_gain"]),
    createdAt: String(row["created_at"]),
    runId: (row["run_id"] as string | null) ?? null,
    dataDigest: String(row["data_digest"] ?? ""),
    coefficients: (row["coefficients"] as StoredCoefficients) ?? {},
    training: (row["training"] as ModelVersionRow["training"]) ?? {},
    before: (row["metrics_before"] as ModelVersionRow["before"]) ?? {},
    after: (row["metrics_after"] as ModelVersionRow["after"]) ?? {},
  };
}

/** Refit history and per-lineage before/after performance for the signed-in user. */
export const getRefitOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RefitOverview> => {
    const [{ data: runRows }, { data: versionRows }] = await Promise.all([
      context.supabase
        .from("coebis_refit_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(20),
      context.supabase
        .from("coebis_model_versions")
        .select("*")
        .order("version", { ascending: false })
        .limit(200),
    ]);

    const runs: RefitRunRow[] = ((runRows ?? []) as unknown as Record<string, unknown>[]).map(
      (row) => ({
        id: String(row["id"]),
        trigger: String(row["trigger"] ?? "scheduled"),
        status: String(row["status"] ?? "running"),
        startedAt: String(row["started_at"]),
        finishedAt: (row["finished_at"] as string | null) ?? null,
        validatedPoints: Number(row["validated_points"] ?? 0),
        rejected: (row["rejected"] as Record<string, number>) ?? {},
        lineagesConsidered: Number(row["lineages_considered"] ?? 0),
        lineagesRefitted: Number(row["lineages_refitted"] ?? 0),
        modelsPromoted: Number(row["models_promoted"] ?? 0),
        summary: (row["summary"] as string | null) ?? null,
        detail: Array.isArray(row["detail"]) ? (row["detail"] as LineageRefitRecord[]) : [],
        error: (row["error"] as string | null) ?? null,
      }),
    );

    const byLineage = new Map<string, ModelVersionRow[]>();
    for (const raw of (versionRows ?? []) as unknown as Record<string, unknown>[]) {
      const v = mapVersion(raw);
      byLineage.set(v.lineageKey, [...(byLineage.get(v.lineageKey) ?? []), v]);
    }
    const lineages: LineageHistory[] = [...byLineage.entries()]
      .map(([lineageKey, versions]) => {
        const sorted = versions.sort((a, b) => b.version - a.version);
        return {
          lineageKey,
          activeVersion: sorted.find((v) => v.isActive)?.version ?? null,
          versions: sorted,
          latest: sorted[0] ?? null,
        };
      })
      .sort((a, b) => a.lineageKey.localeCompare(b.lineageKey));

    return { runs, lineages, lastRunAt: runs[0]?.startedAt ?? null };
  });

/** Run the pipeline immediately for the signed-in user's own data. */
export const runRefitNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runRefitForUser } = await import("@/lib/eeg/coebis-refit.server");
    // Scoped to the caller's own user id, so the privileged client can only
    // ever refit the data the caller already owns.
    const report = await runRefitForUser(supabaseAdmin as never, context.userId, "manual");
    return {
      status: report.status,
      summary: report.summary,
      lineagesRefitted: report.lineagesRefitted,
      modelsPromoted: report.modelsPromoted,
      validatedPoints: report.validatedPoints,
      error: report.error ?? null,
    };
  });
