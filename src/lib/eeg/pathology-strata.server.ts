/**
 * Server-only loader for pathology-stratified evaluation: takes the COEBIS
 * training matrix and attaches, to each paired reading, the analysed epoch it
 * sits in (suppression / seizure activity) plus the clinical labels of its case.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadTrainingMatrix } from "./coebis-training.server";
import { outOfFoldPredictions, type CoebisFamily } from "./coebis-covariates";
import {
  evaluateByPathology,
  type PathologyEvaluation,
  type PathologyPoint,
} from "./pathology-strata";

type Client = SupabaseClient<any, any, any>;

/** Widest gap tolerated between a reading and the epoch used to describe it. */
const MATCH_WINDOW_SECONDS = 3;

interface EpochRow {
  session_id: string;
  t_offset_seconds: number;
  suppression_ratio: number | null;
  is_suppressed: boolean | null;
  seizure_score: number | null;
}

interface SessionLabelRow {
  id: string;
  context: string | null;
  clinical_features: string[] | null;
}

export interface PathologyEvaluationResult extends PathologyEvaluation {
  family: CoebisFamily;
  /** Readings whose epoch context could not be matched. */
  unmatchedEpochs: number;
}

export async function evaluatePathologyStrata(
  supabase: Client,
  family: CoebisFamily = "covariate",
  limit = 5000,
): Promise<PathologyEvaluationResult> {
  const matrix = await loadTrainingMatrix(supabase, limit);
  const sessionIds = [
    ...new Set(
      matrix.points
        .map((p) => p.sessionId)
        .filter((v): v is string => typeof v === "string" && !v.startsWith("import:")),
    ),
  ];

  const labels = new Map<string, SessionLabelRow>();
  const epochsBySession = new Map<string, EpochRow[]>();

  if (sessionIds.length) {
    const [{ data: sessionRows }, { data: epochRows }] = await Promise.all([
      supabase.from("eeg_sessions").select("id, context, clinical_features").in("id", sessionIds),
      supabase
        .from("eeg_epochs")
        .select("session_id, t_offset_seconds, suppression_ratio, is_suppressed, seizure_score")
        .in("session_id", sessionIds)
        .order("t_offset_seconds", { ascending: true })
        .limit(50000),
    ]);
    for (const s of (sessionRows ?? []) as unknown as SessionLabelRow[]) labels.set(s.id, s);
    for (const raw of (epochRows ?? []) as unknown as Record<string, unknown>[]) {
      const row: EpochRow = {
        session_id: String(raw["session_id"]),
        t_offset_seconds: Number(raw["t_offset_seconds"]),
        suppression_ratio:
          raw["suppression_ratio"] == null ? null : Number(raw["suppression_ratio"]),
        is_suppressed: raw["is_suppressed"] == null ? null : Boolean(raw["is_suppressed"]),
        seizure_score: raw["seizure_score"] == null ? null : Number(raw["seizure_score"]),
      };
      epochsBySession.set(row.session_id, [...(epochsBySession.get(row.session_id) ?? []), row]);
    }
  }

  let unmatchedEpochs = 0;
  const points: PathologyPoint[] = matrix.points.map((p) => {
    const sessionId = p.sessionId;
    const epochs = sessionId ? epochsBySession.get(sessionId) : undefined;
    let best: EpochRow | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const e of epochs ?? []) {
      const gap = Math.abs(e.t_offset_seconds - p.at);
      if (gap < bestGap) {
        bestGap = gap;
        best = e;
      }
    }
    if (!best || bestGap > MATCH_WINDOW_SECONDS) {
      unmatchedEpochs++;
      best = null;
    }
    const label = sessionId ? labels.get(sessionId) : undefined;
    return {
      ...p,
      epoch: best
        ? {
            suppressionRatio: best.suppression_ratio,
            isSuppressed: best.is_suppressed,
            seizureScore: best.seizure_score,
          }
        : null,
      careContext: label?.context ?? p.context ?? null,
      clinicalFeatures: Array.isArray(label?.clinical_features) ? label!.clinical_features! : [],
    };
  });

  const predictions = outOfFoldPredictions(points, family);
  const evaluation = evaluateByPathology(points, (_p, i) => predictions[i] ?? null);
  return { ...evaluation, family, unmatchedEpochs };
}
