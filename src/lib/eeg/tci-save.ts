/**
 * Persist the contemporaneous TCI record for a filed case.
 *
 * Until now the pumps a clinician logged lived only in memory for the duration
 * of the case, so the drug state behind every EEG epoch was lost the moment the
 * case was filed. Storing it makes the dosing history available to the AI
 * reviewer and, more importantly, gives the depth model a drug covariate to
 * learn from.
 */

import { supabase } from "@/integrations/supabase/client";
import type { TciInfusion } from "@/lib/eeg/tci";

export async function saveInfusions(
  sessionId: string,
  userId: string,
  infusions: TciInfusion[],
): Promise<void> {
  if (!infusions.length) return;
  const rows = infusions.map((i) => ({
    user_id: userId,
    session_id: sessionId,
    client_id: i.id,
    model_key: i.modelKey,
    started_seconds: Number(i.startedAt.toFixed(2)),
    stopped_seconds: i.stoppedAt == null ? null : Number(i.stoppedAt.toFixed(2)),
  }));
  const { data, error } = await supabase.from("tci_infusions").insert(rows).select("id, client_id");
  if (error) throw new Error(error.message);

  const idFor = new Map((data ?? []).map((r) => [r.client_id as string, r.id as string]));
  const points = infusions.flatMap((i) => {
    const infusionId = idFor.get(i.id);
    if (!infusionId) return [];
    const history =
      i.history && i.history.length ? i.history : [{ at: i.startedAt, targets: i.targets }];
    return history.map((p) => ({
      user_id: userId,
      session_id: sessionId,
      infusion_id: infusionId,
      at_seconds: Number(p.at.toFixed(2)),
      targets: p.targets as unknown as never,
    }));
  });
  if (!points.length) return;
  const { error: pointError } = await supabase.from("tci_ce_points").insert(points);
  if (pointError) throw new Error(pointError.message);
}
