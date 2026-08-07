/**
 * Client-side loading of the active BIS alignment — the gain/offset the app
 * has fitted from pooled comparisons with a commercial BIS monitor. Applied to
 * the live depth index so the bedside trend tracks the monitor more closely.
 */
import { supabase } from "@/integrations/supabase/client";
import { setActiveBisAlignment, type BisAlignment } from "@/lib/eeg/depth";

export async function fetchActiveBisAlignment(): Promise<BisAlignment | null> {
  const { data, error } = await supabase
    .from("depth_bis_alignments")
    .select('gain, "offset", n_points, created_at')
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const gain = Number(data.gain);
  const offset = Number(data.offset);
  if (!Number.isFinite(gain) || !Number.isFinite(offset)) return null;
  return { gain, offset, n: Number(data.n_points) || 0, fittedAt: String(data.created_at) };
}

/** Fetch and apply the active alignment to the live estimator. */
export async function syncBisAlignment(): Promise<BisAlignment | null> {
  try {
    const alignment = await fetchActiveBisAlignment();
    setActiveBisAlignment(alignment);
    return alignment;
  } catch {
    return null;
  }
}
