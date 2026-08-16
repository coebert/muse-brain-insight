/** Builds the prospective validation report (Phase 6). Server-only. */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  agreementSummary,
  predictCoebis,
  stratifiedAgreement,
} from "./coebis-covariates";
import { biasStatistic, clusterBootstrapCi, maeStatistic, type ClusteredPair } from "./ci";
import type { ProspectiveReport, ProspectiveLockSummary } from "./prospective.functions";
import { loadLocks, splitAtLock } from "./prospective.server";

type Client = SupabaseClient<any, any, any>;

export async function buildProspectiveReport(
  supabase: Client,
  lockId: string | null,
): Promise<ProspectiveReport> {
  const { loadTrainingMatrix } = await import("./coebis-training.server");
  const [locks, matrix] = await Promise.all([loadLocks(supabase), loadTrainingMatrix(supabase)]);

  const summaries: ProspectiveLockSummary[] = locks.map((lock) => {
    const split = splitAtLock(matrix.points, lock.lockedAt);
    return {
      id: lock.id,
      label: lock.label,
      note: lock.note,
      lockedAt: lock.lockedAt,
      modelVersion: lock.modelVersion,
      modelFamily: lock.modelFamily,
      isActive: lock.isActive,
      trainingReadings: split.before.length,
      unseenReadings: split.after.length,
      unseenCases: new Set(split.after.map((p) => p.sessionId ?? "unfiled")).size,
    };
  });

  const chosen = lockId ? locks.find((l) => l.id === lockId) : (locks.find((l) => l.isActive) ?? locks[0]);
  if (!chosen) {
    return {
      locks: summaries,
      activeLockId: null,
      prospective: null,
      baseline: null,
      maeCi: null,
      biasCi: null,
      strata: [],
      blandAltman: [],
      summary:
        "No model locked yet. Lock the current COEBIS fit to start a prospective test: every paired reading you take afterwards is scored against a model that never saw it.",
    };
  }

  const { after } = splitAtLock(matrix.points, chosen.lockedAt);
  if (!after.length) {
    return {
      locks: summaries,
      activeLockId: chosen.id,
      prospective: null,
      baseline: null,
      maeCi: null,
      biasCi: null,
      strata: [],
      blandAltman: [],
      summary: `“${chosen.label}” was locked on ${new Date(chosen.lockedAt).toLocaleDateString()}. No paired readings have been logged since, so there is nothing prospective to score yet.`,
    };
  }

  const predictions = after.map((p) => predictCoebis(chosen.model, p, false));
  const prospective = agreementSummary(
    after.map((p, i) => ({ predicted: predictions[i]!, bis: p.bis })),
  );
  const baseline = agreementSummary(after.map((p) => ({ predicted: p.appIndex, bis: p.bis })));

  const pairs: ClusteredPair[] = after.map((p, i) => ({
    caseKey: p.sessionId ?? "unfiled",
    predicted: predictions[i]!,
    bis: p.bis,
  }));
  const maeCi = clusterBootstrapCi(pairs, maeStatistic);
  const biasCi = clusterBootstrapCi(pairs, biasStatistic);

  const strata = stratifiedAgreement(after, (_p, i) => predictions[i] ?? null);
  const blandAltman = after.map((p, i) => ({
    mean: Number(((predictions[i]! + p.bis) / 2).toFixed(1)),
    diff: Number((predictions[i]! - p.bis).toFixed(1)),
  }));

  const cases = new Set(after.map((p) => p.sessionId ?? "unfiled")).size;
  const better =
    prospective.mae != null && baseline.mae != null
      ? prospective.mae < baseline.mae
        ? `better than the published index (${baseline.mae.toFixed(1)})`
        : `no better than the published index (${baseline.mae.toFixed(1)})`
      : "";

  return {
    locks: summaries,
    activeLockId: chosen.id,
    prospective,
    baseline,
    maeCi,
    biasCi,
    strata,
    blandAltman,
    summary: `On ${after.length} reading${after.length === 1 ? "" : "s"} from ${cases} case${cases === 1 ? "" : "s"} recorded after “${chosen.label}” was locked, COEBIS is out by ${prospective.mae?.toFixed(1) ?? "—"} index points on average${better ? `, ${better}` : ""}. ${prospective.within5 ?? 0}% of readings fall within 5 points of the monitor and the concordance coefficient is ${prospective.ccc ?? "—"}.`,
  };
}
