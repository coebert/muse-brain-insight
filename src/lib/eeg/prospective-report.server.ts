/** Builds the prospective validation report (Phase 6). Server-only. */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  agreementSummary,
  predictCoebis,
  stratifiedAgreement,
} from "./coebis-covariates";
import { biasStatistic, clusterBootstrapCi, maeStatistic, type ClusteredPair } from "./ci";
import { repeatedMeasuresBlandAltman } from "./bland-altman";
import { buildDiscriminationReport } from "./discrimination-report";
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
      straddlingCases: split.straddlingCases,
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
      agreement: null,
      discrimination: null,
      straddlingCases: 0,
      summary:
        "No model locked yet. Lock the current COEBIS fit to start a prospective test: every paired reading you take afterwards is scored against a model that never saw it.",
    };
  }

  const { after, straddlingCases } = splitAtLock(matrix.points, chosen.lockedAt);
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
      agreement: null,
      discrimination: null,
      straddlingCases,
      summary: `“${chosen.label}” was locked on ${new Date(chosen.lockedAt).toLocaleDateString()}. No readings from a patient the model has never seen have been logged since, so there is nothing prospective to score yet.${
        straddlingCases
          ? ` ${straddlingCases} case${straddlingCases === 1 ? " was" : "s were"} already running at the lock, so ${straddlingCases === 1 ? "its" : "their"} later readings count as training data.`
          : ""
      }`,
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
  // Limits of agreement that respect repeated readings within a case.
  const agreement = repeatedMeasuresBlandAltman(
    after.map((p, i) => ({
      caseKey: p.sessionId ?? "unfiled",
      predicted: predictions[i]!,
      reference: p.bis,
    })),
  );
  // Does the locked model still order clinical states correctly on new patients?
  const discrimination = buildDiscriminationReport(
    after.map((p) => ({ bis: p.bis, bisSr: null, sessionId: p.sessionId })),
    [
      { key: "raw", label: "Published open index", values: after.map((p) => p.appIndex) },
      { key: "coebis", label: "COEBIS (locked)", values: predictions },
    ],
  );

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
    agreement,
    discrimination,
    straddlingCases,
    summary: `On ${after.length} reading${after.length === 1 ? "" : "s"} from ${cases} patient${cases === 1 ? "" : "s"} the locked “${chosen.label}” model has never seen, COEBIS is out by ${prospective.mae?.toFixed(1) ?? "—"} index points on average${better ? `, ${better}` : ""}. ${prospective.within5 ?? 0}% of readings fall within 5 points of the monitor and the concordance coefficient is ${prospective.ccc ?? "—"}.${
      straddlingCases
        ? ` ${straddlingCases} case${straddlingCases === 1 ? "" : "s"} straddling the lock ${straddlingCases === 1 ? "was" : "were"} left out of this test, because the model was partly fitted on ${straddlingCases === 1 ? "it" : "them"}.`
        : ""
    }`,
  };
}
