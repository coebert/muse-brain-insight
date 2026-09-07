/**
 * Background computation and storage for the analysis screens.
 *
 * Each screen has a job key. The stored row in `analysis_cache` holds the last
 * finished result plus how long it took and how many readings it scanned. A
 * page read is a single indexed row lookup, so it returns immediately no matter
 * how large the recording pool is.
 *
 * Safeguards, because these passes are expensive:
 *  - one job per invocation, so no run can fan out across the whole registry;
 *  - a database claim (status `running` + `requested_at`) is taken before any
 *    work starts, so a second concurrent request exits instead of doubling the
 *    load; an abandoned claim is reclaimable after CLAIM_SECONDS;
 *  - failures are recorded on the row rather than thrown away, and the previous
 *    good payload is kept so the screen keeps showing something usable.
 */
import {
  claimExpired,
  isStale,
  type AnalysisJobKey,
  type AnalysisStatus,
  type CachedAnalysis,
} from "@/lib/eeg/analysis-cache";

type Client = {
  from: (table: string) => any;
};

interface JobDefinition {
  /** What the screen calls this result, in plain words. */
  label: string;
  compute: (supabase: Client, userId: string) => Promise<{ payload: unknown; rows: number }>;
}

/** Rough scan size, only used to show how much work a pass did. */
function countRows(payload: unknown, keys: string[]): number {
  const rec = payload as Record<string, unknown> | null;
  if (!rec) return 0;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "number") return value;
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

export const ANALYSIS_JOB_REGISTRY: Record<AnalysisJobKey, JobDefinition> = {
  "suppression-dashboard": {
    label: "Suppression and depth dashboard",
    compute: async (supabase, userId) => {
      const { loadSuppressionDashboard } = await import("@/lib/eeg/suppression-dashboard.server");
      // Keep the reading pool at the size the screens used before this job
      // existed, so no recording silently drops out of the case list.
      const payload = await loadSuppressionDashboard(supabase as never, userId, { limit: 80000 });
      return { payload, rows: countRows(payload, ["casesWithBis", "cases"]) };
    },
  },
  "pathology-labels": {
    label: "Recorded clinical labels",
    compute: async (supabase) => {
      const { loadPathologyLabelEvaluation } = await import("@/lib/eeg/pathology-labels.server");
      const payload = await loadPathologyLabelEvaluation(supabase as never, 8000);
      return { payload, rows: countRows(payload, ["scanned", "epochs"]) };
    },
  },
  "bis-benchmark": {
    label: "Monitor comparison",
    compute: async (supabase, userId) => {
      const { loadBisBenchmark } = await import("@/lib/eeg/bis-benchmark.server");
      const payload = await loadBisBenchmark(supabase as never, userId, 200000);
      return { payload, rows: countRows(payload, ["readings", "points", "n"]) };
    },
  },
  "coebis-blockers": {
    label: "Blocked lineages",
    compute: async (supabase) => {
      const { loadBlockerReport } = await import("@/lib/eeg/coebis-blockers.server");
      const payload = await loadBlockerReport(supabase as never);
      return { payload, rows: countRows(payload, ["validatedPoints"]) };
    },
  },
  "live-accuracy": {
    label: "Model accuracy in use",
    compute: async (supabase, userId) => {
      const { loadLiveAccuracy } = await import("@/lib/eeg/lineage-live-accuracy.server");
      const payload = await loadLiveAccuracy(supabase as never, userId, 120000);
      return { payload, rows: countRows(payload, ["readings", "points", "lineages"]) };
    },
  },
  "ketamine-cases": {
    label: "Ketamine signature",
    compute: async (supabase) => {
      const { loadKetamineCases } = await import("@/lib/eeg/ketamine-cases.server");
      const payload = await loadKetamineCases(supabase as never, 40000);
      return { payload, rows: countRows(payload, ["readings", "cases"]) };
    },
  },
  "drug-exposure": {
    label: "Drug exposure",
    compute: async (supabase) => {
      const { loadDrugExposure } = await import("@/lib/eeg/drug-exposure.server");
      const payload = await loadDrugExposure(supabase as never, 30000);
      return { payload, rows: countRows(payload, ["readings", "cases"]) };
    },
  },
};

const COLUMNS =
  "job_key, status, payload, rows_scanned, duration_ms, error, requested_at, computed_at";

function toCached<T>(jobKey: AnalysisJobKey, row: Record<string, unknown> | null): CachedAnalysis<T> {
  if (!row) {
    return {
      jobKey,
      status: "queued",
      payload: null,
      computedAt: null,
      requestedAt: null,
      durationMs: null,
      rowsScanned: 0,
      error: null,
      refreshing: false,
      stale: true,
    };
  }
  const status = String(row["status"] ?? "queued") as AnalysisStatus;
  const computedAt = (row["computed_at"] as string | null) ?? null;
  const payload = computedAt ? ((row["payload"] as T) ?? null) : null;
  return {
    jobKey,
    status,
    payload,
    computedAt,
    requestedAt: (row["requested_at"] as string | null) ?? null,
    durationMs: row["duration_ms"] == null ? null : Number(row["duration_ms"]),
    rowsScanned: Number(row["rows_scanned"] ?? 0),
    error: (row["error"] as string | null) ?? null,
    refreshing: status === "queued" || status === "running",
    stale: isStale(computedAt),
  };
}

/** The stored result, if any. A single indexed row read. */
export async function readAnalysisCache<T>(
  supabase: Client,
  userId: string,
  jobKey: AnalysisJobKey,
): Promise<CachedAnalysis<T>> {
  const { data } = await supabase
    .from("analysis_cache")
    .select(COLUMNS)
    .eq("user_id", userId)
    .eq("job_key", jobKey)
    .maybeSingle();
  return toCached<T>(jobKey, (data as Record<string, unknown> | null) ?? null);
}

/**
 * Take the claim for one job. Returns false when another pass already holds it
 * and has not been abandoned, so the caller exits without doing the work twice.
 */
async function claim(
  supabase: Client,
  userId: string,
  jobKey: AnalysisJobKey,
  force: boolean,
): Promise<{ taken: boolean; existing: CachedAnalysis<unknown> }> {
  const existing = await readAnalysisCache(supabase, userId, jobKey);
  const busy =
    (existing.status === "running" || existing.status === "queued") &&
    !claimExpired(existing.requestedAt);
  if (busy) return { taken: false, existing };
  if (!force && existing.status === "ready" && !existing.stale) {
    return { taken: false, existing };
  }

  const { error } = await supabase.from("analysis_cache").upsert(
    {
      user_id: userId,
      job_key: jobKey,
      status: "running",
      requested_at: new Date().toISOString(),
      error: null,
    },
    { onConflict: "user_id,job_key" },
  );
  if (error) return { taken: false, existing };
  return { taken: true, existing };
}

/**
 * Work out one result and store it. Bounded to a single job per call; the
 * caller is a background request, never a page render.
 */
export async function runAnalysisJob<T>(
  supabase: Client,
  userId: string,
  jobKey: AnalysisJobKey,
  options: { force?: boolean } = {},
): Promise<CachedAnalysis<T>> {
  const job = ANALYSIS_JOB_REGISTRY[jobKey];
  if (!job) throw new Error(`Unknown analysis job: ${jobKey}`);

  const { taken, existing } = await claim(supabase, userId, jobKey, options.force ?? false);
  if (!taken) return existing as CachedAnalysis<T>;

  const started = Date.now();
  try {
    const { payload, rows } = await job.compute(supabase, userId);
    await supabase.from("analysis_cache").upsert(
      {
        user_id: userId,
        job_key: jobKey,
        status: "ready",
        payload: payload as never,
        rows_scanned: rows,
        duration_ms: Date.now() - started,
        error: null,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "user_id,job_key" },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep the previous payload: a failed refresh must not blank the screen.
    await supabase
      .from("analysis_cache")
      .update({
        status: existing.computedAt ? "ready" : "failed",
        duration_ms: Date.now() - started,
        error: message,
      })
      .eq("user_id", userId)
      .eq("job_key", jobKey);
  }

  return readAnalysisCache<T>(supabase, userId, jobKey);
}
