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
  const history = await fetchBisAlignmentHistory();
  return history.find((a) => a.isActive) ?? history[0] ?? null;
}

/**
 * Every COEBIS fit this user has produced, newest first, numbered from the
 * oldest fit so a version label stays stable as new fits are added. Used both
 * to label the number on screen and to let a clinician step back to an earlier
 * model for comparison.
 */
export async function fetchBisAlignmentHistory(limit = 40): Promise<BisAlignment[]> {
  const { data, error } = await supabase
    .from("depth_bis_alignments")
    .select('id, gain, "offset", n_points, created_at, knots, is_active, bias_after, mae_after')
    .order("created_at", { ascending: true })
    .limit(200);
  if (error || !data) return [];
  const all = data
    .map((row, i) => {
      const gain = Number(row.gain);
      const offset = Number(row.offset);
      if (!Number.isFinite(gain) || !Number.isFinite(offset)) return null;
      return {
        gain,
        offset,
        knots: toKnots((row as { knots?: unknown }).knots),
        n: Number(row.n_points) || 0,
        fittedAt: String(row.created_at),
        id: String(row.id),
        version: i + 1,
        isActive: Boolean(row.is_active),
        biasAfter: row.bias_after === null ? null : Number(row.bias_after),
        maeAfter: row.mae_after === null ? null : Number(row.mae_after),
      } satisfies BisAlignment;
    })
    .filter((a): a is BisAlignment => a !== null);
  return all.reverse().slice(0, limit);
}

/**
 * The model currently driving COEBIS, mirrored here so the bedside tiles can
 * show which version they are displaying without re-querying.
 */
let syncedAlignment: BisAlignment | null = null;
let syncedAt = 0;
/**
 * A previous fit the clinician has pinned for comparison. While set it drives
 * every displayed COEBIS number; the live model keeps syncing underneath so
 * releasing the pin returns to the newest fit immediately.
 */
let pinnedAlignment: BisAlignment | null = null;
const listeners = new Set<(alignment: BisAlignment | null) => void>();

export function getSyncedBisAlignment(): BisAlignment | null {
  return pinnedAlignment ?? syncedAlignment;
}

/** The newest fit, ignoring any pinned comparison version. */
export function getLatestBisAlignment(): BisAlignment | null {
  return syncedAlignment;
}

export function isBisAlignmentPinned(): boolean {
  return pinnedAlignment !== null;
}

/** Pin an earlier fit (or `null` to go back to the live model). */
export function pinBisAlignment(alignment: BisAlignment | null) {
  pinnedAlignment = alignment;
  const effective = pinnedAlignment ?? syncedAlignment;
  setActiveBisAlignment(effective);
  for (const fn of listeners) fn(effective);
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
    if (!pinnedAlignment) setActiveBisAlignment(alignment);
    const changed =
      (syncedAlignment?.fittedAt ?? null) !== (alignment?.fittedAt ?? null) ||
      (syncedAlignment?.n ?? 0) !== (alignment?.n ?? 0);
    syncedAlignment = alignment;
    syncedAt = Date.now();
    if (changed && !pinnedAlignment) for (const fn of listeners) fn(alignment);
    return pinnedAlignment ?? alignment;
  } catch {
    return null;
  }
}

/** Re-sync only when the mirrored copy is older than `maxAgeMs`. */
export async function syncBisAlignmentIfStale(maxAgeMs = 5 * 60_000): Promise<BisAlignment | null> {
  if (syncedAt && Date.now() - syncedAt < maxAgeMs) return pinnedAlignment ?? syncedAlignment;
  return syncBisAlignment();
}
