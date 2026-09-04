/**
 * Builds the training matrix COEBIS learns from: every paired
 * commercial-BIS/app reading joined to the covariates of the case it came from
 * and to whatever TCI targets were running at that moment.
 *
 * Server-only: it reads across all of a user's cases with their own RLS-scoped
 * client, and is imported by server functions rather than by components.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoebisTrainingPoint } from "./coebis-covariates";
import { summariseLineages, type LineageSummary } from "./model-lineage";

type Client = SupabaseClient<any, any, any>;

interface SessionCovariateRow {
  id: string;
  age_band: string | null;
  sex: string | null;
  regimen: string | null;
  frailty: string | null;
  chronic_burden: string | null;
  chronic_cns: string | null;
  acute_class: string | null;
}

export interface TrainingMatrix {
  points: CoebisTrainingPoint[];
  /** Cases that contributed at least one reading. */
  cases: number;
  /** Readings that could not be attributed to a filed case. */
  unfiled: number;
  /** Readings whose case has no age band recorded. */
  missingAge: number;
  missingRegimen: number;
  /** Which acquisition setups the pooled readings actually span. */
  lineages: LineageSummary;
}

/** Load every paired reading with its patient covariates attached. */
export async function loadTrainingMatrix(
  supabase: Client,
  limit = 5000,
  /**
   * Restrict to one owner. Required when the caller holds a service-role
   * client (the scheduled refit job), where RLS does not scope the read.
   */
  userId?: string,
  /**
   * Cap per acquisition lineage. Without it, one heavily ingested lineage
   * (VitalDB) consumes the whole global budget and smaller lineages such as
   * DOSE-I never reach the refit at all.
   */
  perLineageLimit = Number.POSITIVE_INFINITY,
): Promise<TrainingMatrix> {

  // The data API caps a single response at 1000 rows, so a plain `.limit()`
  // silently truncates the oldest slice of the pool and hides whole lineages
  // from the refit. Page through explicitly instead.
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    let query = supabase
      .from("bis_paired_points")
      .select(
        "at_seconds, bis, app_index, app_sr, session_id, reliable, sqi, depth_confidence, recorded_at, context, ce, features, source_lineage",
      );
    if (userId) query = query.eq("user_id", userId);
    const { data: pointRows, error } = await query
      .order("recorded_at", { ascending: true })
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) throw new Error(error.message);
    const page = (pointRows ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const sessionIds = [
    ...new Set(rows.map((r) => r["session_id"]).filter((v): v is string => typeof v === "string")),
  ];

  const covariates = new Map<string, SessionCovariateRow>();
  if (sessionIds.length) {
    const { data: sessions } = await supabase
      .from("eeg_sessions")
      .select("id, age_band, sex, regimen, frailty, chronic_burden, chronic_cns, acute_class")
      .in("id", sessionIds);
    for (const s of (sessions ?? []) as unknown as SessionCovariateRow[]) {
      covariates.set(s.id, s);
    }
  }

  let missingAge = 0;
  let missingRegimen = 0;
  let unfiled = 0;

  const points: CoebisTrainingPoint[] = rows.map((r) => {
    const rawSessionId = (r["session_id"] as string | null) ?? null;
    // Imported readings carry their own pseudonymous case ref and covariates,
    // so they still group per case rather than collapsing into one bucket.
    const features = (r["features"] as Record<string, unknown> | null) ?? null;
    const imported = !rawSessionId && features?.["imported"] === true;
    const sessionId = rawSessionId ?? (imported ? `import:${String(features?.["caseRef"] ?? "?")}` : null);
    const cov = rawSessionId
      ? covariates.get(rawSessionId)
      : imported
        ? {
            id: sessionId!,
            age_band: (features?.["ageBand"] as string | null) ?? null,
            sex: (features?.["sex"] as string | null) ?? null,
            regimen: (features?.["regimen"] as string | null) ?? null,
            frailty: (features?.["frailty"] as string | null) ?? null,
            chronic_burden: (features?.["chronicBurden"] as string | null) ?? null,
            chronic_cns: (features?.["chronicCns"] as string | null) ?? null,
            acute_class: (features?.["acuteClass"] as string | null) ?? null,
          }
        : undefined;
    if (!sessionId) unfiled++;
    if (!cov?.age_band) missingAge++;
    if (!cov?.regimen) missingRegimen++;
    return {
      at: Number(r["at_seconds"]),
      bis: Number(r["bis"]),
      appIndex: Number(r["app_index"]),
      appSr: r["app_sr"] == null ? null : Number(r["app_sr"]),
      sessionId,
      reliable: Boolean(r["reliable"]),
      sqi: r["sqi"] == null ? null : Number(r["sqi"]),
      depthConfidence:
        r["depth_confidence"] == null ? null : Number(r["depth_confidence"]),
      recordedAt: String(r["recorded_at"]),
      context: (r["context"] as string | null) ?? null,
      ce: (r["ce"] as Record<string, number> | null) ?? null,
      lineageKey: (r["source_lineage"] as string | null) ?? null,
      cov: {
        ageBand: cov?.age_band ?? null,
        sex: cov?.sex ?? null,
        regimen: cov?.regimen ?? null,
        frailty: cov?.frailty ?? null,
        chronicBurden: cov?.chronic_burden ?? null,
        chronicCns: cov?.chronic_cns ?? null,
        acuteClass: cov?.acute_class ?? null,
      },
    } satisfies CoebisTrainingPoint;
  });

  const finite = points.filter((p) => Number.isFinite(p.bis) && Number.isFinite(p.appIndex));
  // Keep the newest slice of each lineage rather than the newest slice of the
  // pool, so every acquisition setup arrives at the refit with its own budget.
  const perLineage = new Map<string, number>();
  const usable = Number.isFinite(perLineageLimit)
    ? [...finite].reverse().filter((p) => {
        const key = p.lineageKey ?? "unlabelled";
        const seen = (perLineage.get(key) ?? 0) + 1;
        perLineage.set(key, seen);
        return seen <= perLineageLimit;
      }).reverse()
    : finite;
  return {
    points: usable,

    cases: new Set(usable.map((p) => p.sessionId).filter(Boolean)).size,
    unfiled,
    missingAge,
    missingRegimen,
    lineages: summariseLineages(usable),
  };
}
