/**
 * Server-side loading for the suppression model: every paired reading that
 * carries a monitor suppression ratio, grouped by the case it came from.
 *
 * Only VitalDB currently ships an SR label alongside the index, so that is the
 * lineage the model is fitted on. The loader is written per-lineage rather
 * than hard-wired to VitalDB, so a second labelled source drops straight in.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  caseDisagreements,
  crossValidate,
  emptyReport,
  gradePairing,
  type SuppressionPoint,
  type SuppressionReport,
} from "./suppression-model";

type Client = SupabaseClient<any, any, any>;

/** The lineage prefix whose readings carry monitor SR labels. */
export const SR_LINEAGE_PREFIX = "vitaldb";

const PAGE = 1000;

/** Pull every reading with both an app SR and a monitor SR. */
export async function loadSuppressionPoints(
  supabase: Client,
  userId: string,
  limit = 40000,
): Promise<SuppressionPoint[]> {
  const out: SuppressionPoint[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("bis_paired_points")
      .select("at_seconds, bis, bis_sr, app_index, app_sr, sqi, reliable, features, session_id")
      .eq("user_id", userId)
      .like("source_lineage", `${SR_LINEAGE_PREFIX}%`)
      .not("bis_sr", "is", null)
      .not("app_sr", "is", null)
      .order("at_seconds", { ascending: true })
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of rows) {
      const features = (r["features"] as Record<string, unknown> | null) ?? null;
      const caseRef =
        (typeof features?.["caseRef"] === "string" ? (features["caseRef"] as string) : null) ??
        (typeof r["session_id"] === "string" ? (r["session_id"] as string) : null) ??
        "unattributed";
      const appSr = Number(r["app_sr"]);
      const bisSr = Number(r["bis_sr"]);
      if (!Number.isFinite(appSr) || !Number.isFinite(bisSr)) continue;
      out.push({
        caseRef,
        atSeconds: Number(r["at_seconds"]) || 0,
        appSr,
        bisSr,
        appIndex: r["app_index"] == null ? null : Number(r["app_index"]),
        bis: r["bis"] == null ? null : Number(r["bis"]),
        sqi: r["sqi"] == null ? null : Number(r["sqi"]),
        reliable: Boolean(r["reliable"]),
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Fit, pair and grade in one pass — everything the page renders. */
export async function loadSuppressionReport(
  supabase: Client,
  userId: string,
  limit = 40000,
): Promise<SuppressionReport> {
  const points = await loadSuppressionPoints(supabase, userId, limit);
  if (!points.length) return emptyReport();
  const fit = crossValidate(SR_LINEAGE_PREFIX, points);
  return {
    fit,
    pairing: gradePairing(points, fit.model),
    worstCases: caseDisagreements(points, fit.model),
  };
}
