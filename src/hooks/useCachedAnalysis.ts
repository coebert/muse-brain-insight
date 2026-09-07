/**
 * Read an analysis screen's stored result, and quietly work out a fresh one in
 * the background when it is missing or old.
 *
 * The page never waits on the heavy pass: it renders the last finished result
 * straight away, and swaps in the new one when it arrives.
 */
import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import type { AnalysisJobKey, CachedAnalysis } from "@/lib/eeg/analysis-cache";
import { getCachedAnalysis, refreshCachedAnalysis } from "@/lib/eeg/analysis-cache.functions";

const POLL_MS = 4000;

export interface UseCachedAnalysis<T> {
  data: T | null;
  meta: CachedAnalysis<T> | null;
  /** True only before the very first stored result exists. */
  loading: boolean;
  /** True while a fresher result is being worked out. */
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCachedAnalysis<T>(job: AnalysisJobKey): UseCachedAnalysis<T> {
  const read = useServerFn(getCachedAnalysis);
  const compute = useServerFn(refreshCachedAnalysis);
  const queryClient = useQueryClient();
  const queryKey = ["analysis-cache", job];
  const kicked = useRef(false);

  const query = useQuery({
    queryKey,
    queryFn: () => read({ data: { job } }) as Promise<CachedAnalysis<T>>,
    refetchInterval: (q) => {
      const state = q.state.data as CachedAnalysis<T> | undefined;
      return state?.refreshing ? POLL_MS : false;
    },
  });

  const mutation = useMutation({
    mutationFn: (force: boolean) =>
      compute({ data: { job, force } }) as Promise<CachedAnalysis<T>>,
    onSuccess: (fresh) => queryClient.setQueryData(queryKey, fresh),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const meta = query.data ?? null;

  // Kick one background pass per mount when there is nothing stored, or the
  // stored result has aged out. Never on every render, and never in a loop.
  useEffect(() => {
    if (!meta || kicked.current) return;
    if (meta.refreshing) return;
    if (meta.payload && !meta.stale) return;
    kicked.current = true;
    mutation.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.status, meta?.stale, meta?.payload == null]);

  const refresh = useCallback(() => {
    if (mutation.isPending) return;
    mutation.mutate(true);
  }, [mutation]);

  return {
    data: (meta?.payload as T | null) ?? null,
    meta,
    loading: query.isLoading || (!meta?.payload && (meta?.refreshing || mutation.isPending)),
    refreshing: Boolean(meta?.refreshing) || mutation.isPending,
    // A failed refresh must never hide the last good result: while a stored
    // payload exists the screen keeps showing it, and the failure is reported
    // on the status bar instead (CacheStatusBar reads meta.error).
    error: meta?.payload
      ? null
      : (meta?.error ?? (query.error instanceof Error ? query.error.message : null)),
    refresh,
  };
}
