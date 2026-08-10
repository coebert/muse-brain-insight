/**
 * Client-side loading of the active BIS alignment — the gain/offset the app
 * has fitted from pooled comparisons with a commercial BIS monitor. Applied to
 * the live depth index so the bedside trend tracks the monitor more closely.
 */
import { supabase } from "@/integrations/supabase/client";
import { setActiveBisAlignment, type BisAlignment, type BisKnot } from "@/lib/eeg/depth";

function toKnots(value: unknown): BisKnot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((k) => {
      const r = k as { x?: unknown; dy?: unknown };
      return { x: Number(r.x), dy: Number(r.dy) };
    })
    .filter((k) => Number.isFinite(k.x) && Number.isFinite(k.dy));
}

export async function fetchActiveBisAlignment(): Promise<BisAlignment | null> {
  const { data, error } = await supabase
    .from("depth_bis_alignments")
    .select('gain, "offset", n_points, created_at, knots')
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const gain = Number(data.gain);
  const offset = Number(data.offset);
  if (!Number.isFinite(gain) || !Number.isFinite(offset)) return null;
  return {
    gain,
    offset,
    knots: toKnots((data as { knots?: unknown }).knots),
    n: Number(data.n_points) || 0,
    fittedAt: String(data.created_at),
  };
}

/**
 * The model currently driving COEBIS, mirrored here so the bedside tiles can
 * show which version they are displaying without re-querying.
 */
let syncedAlignment: BisAlignment | null = null;
let syncedAt = 0;
const listeners = new Set<(alignment: BisAlignment | null) => void>();

export function getSyncedBisAlignment(): BisAlignment | null {
  return syncedAlignment;
}

/** Subscribe to model swaps; returns an unsubscribe. */
export function subscribeBisAlignment(fn: (alignment: BisAlignment | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fetch and apply the active alignment to the live estimator. */
export async function syncBisAlignment(): Promise<BisAlignment | null> {
  try {
    const alignment = await fetchActiveBisAlignment();
    setActiveBisAlignment(alignment);
    const changed =
      (syncedAlignment?.fittedAt ?? null) !== (alignment?.fittedAt ?? null) ||
      (syncedAlignment?.n ?? 0) !== (alignment?.n ?? 0);
    syncedAlignment = alignment;
    syncedAt = Date.now();
    if (changed) for (const fn of listeners) fn(alignment);
    return alignment;
  } catch {
    return null;
  }
}

/** Re-sync only when the mirrored copy is older than `maxAgeMs`. */
export async function syncBisAlignmentIfStale(maxAgeMs = 5 * 60_000): Promise<BisAlignment | null> {
  if (syncedAt && Date.now() - syncedAt < maxAgeMs) return syncedAlignment;
  return syncBisAlignment();
}
