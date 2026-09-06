/**
 * Shared types for the cached analysis layer.
 *
 * Analysis screens read a stored result instead of recomputing over the whole
 * recording pool on every page view. The heavy work runs in a bounded
 * background pass; the page shows the last finished result, when it was worked
 * out, and whether a fresher one is on its way.
 */

/** Every analysis result the background pass knows how to work out. */
export const ANALYSIS_JOBS = [
  "suppression-dashboard",
  "pathology-labels",
  "bis-benchmark",
  "coebis-blockers",
  "live-accuracy",
  "ketamine-cases",
  "drug-exposure",
] as const;

export type AnalysisJobKey = (typeof ANALYSIS_JOBS)[number];

export function isAnalysisJob(value: string): value is AnalysisJobKey {
  return (ANALYSIS_JOBS as readonly string[]).includes(value);
}

export type AnalysisStatus = "queued" | "running" | "ready" | "failed";

/** A cached result as the page sees it. */
export interface CachedAnalysis<T = unknown> {
  jobKey: AnalysisJobKey;
  status: AnalysisStatus;
  /** null until the first pass finishes. */
  payload: T | null;
  computedAt: string | null;
  requestedAt: string | null;
  durationMs: number | null;
  rowsScanned: number;
  error: string | null;
  /** True when a newer pass has been asked for but has not finished yet. */
  refreshing: boolean;
  /** True when the stored result is older than the freshness window. */
  stale: boolean;
}

/** How long a finished result is treated as current. */
export const FRESH_FOR_MINUTES = 60;

/** How long a running pass may hold the claim before another may take over. */
export const CLAIM_SECONDS = 300;

export function isStale(computedAt: string | null, now = new Date()): boolean {
  if (!computedAt) return true;
  return now.getTime() - new Date(computedAt).getTime() > FRESH_FOR_MINUTES * 60_000;
}

/** True when a "running" row has been abandoned and may be reclaimed. */
export function claimExpired(requestedAt: string | null, now = new Date()): boolean {
  if (!requestedAt) return true;
  return now.getTime() - new Date(requestedAt).getTime() > CLAIM_SECONDS * 1000;
}

/** Plain-language age, for the "last worked out ..." line on each screen. */
export function describeAge(computedAt: string | null, now = new Date()): string {
  if (!computedAt) return "not worked out yet";
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - new Date(computedAt).getTime()) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function emptyCached<T>(jobKey: AnalysisJobKey): CachedAnalysis<T> {
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
