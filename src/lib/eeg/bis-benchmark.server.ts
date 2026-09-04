/**
 * BIS benchmark loader (server only).
 *
 * Reads every validated paired bedside reading the user holds, pairs the
 * recorded commercial BIS with what the app publishes today on that lineage
 * (COEBIS where a version is in force, the raw index otherwise), adds the
 * promoted BIS model's estimate where one exists, and grades the lot per
 * lineage and per case.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildBisBenchmark, type BenchmarkPair, type BisBenchmark } from "./bis-benchmark";
import { predictBis, type BisModel } from "./bis-model";
import { loadActiveBisModels, loadIncumbents, samplesByLineage } from "./bis-model.server";
import { selectValidatedPoints } from "./coebis-refit";
import { loadTrainingMatrix } from "./coebis-training.server";

type Client = SupabaseClient<any, any, any>;

export async function loadBisBenchmark(
  supabase: Client,
  userId: string,
  limit = 200000,
): Promise<BisBenchmark> {
  const matrix = await loadTrainingMatrix(supabase, limit, userId, 100000);
  const validated = selectValidatedPoints(matrix.points);
  const incumbents = await loadIncumbents(supabase, userId);
  const grouped = samplesByLineage(validated.used, incumbents);
  const active = new Map<string, BisModel>();
  for (const m of await loadActiveBisModels(supabase, userId)) active.set(m.lineage, m.model);

  const pairs: BenchmarkPair[] = [];
  for (const [lineage, samples] of grouped) {
    const model = active.get(lineage) ?? null;
    for (const s of samples) {
      pairs.push({
        caseRef: s.caseRef,
        lineage,
        bis: s.bis,
        published: s.baseline,
        // Only a promoted version counts here; a candidate fit is not what the
        // app would say at the bedside.
        model: model ? predictBis(model, s) : null,
      });
    }
  }

  return buildBisBenchmark(pairs, matrix.points.length - validated.used.length);
}
