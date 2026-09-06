/**
 * The headband training pool, with confirmed outcomes attached.
 *
 * Two separate things feed a headband refit, and they must never be confused:
 *
 *  - the *target* is always the value a commercial monitor showed at the same
 *    moment. An outcome cannot supply a depth target — nobody can say what the
 *    index should have read from the fact that a patient became delirious — so
 *    outcomes never enter the fit itself.
 *  - the *outcome* of the case a reading came from is used to grade the fit:
 *    it tells us whether the model's error is concentrated in the recordings
 *    that were followed by a problem, which is exactly where a depth index
 *    matters most.
 *
 * This module builds that pool from the paired bedside readings plus the
 * recorded case outcomes, grades a candidate leave-one-case-out, and splits
 * the held-out error by outcome. It is pure: the loading lives in
 * headband-pool.server.ts.
 */

import {
  agreementSummary,
  fitCoebisModel,
  predictCoebis,
  type AgreementSummary,
  type CoebisModel,
  type CoebisTrainingPoint,
} from "./coebis-covariates";
import { refitHeadbandLineage, type HeadbandFit } from "./headband-fit";

/** How a case turned out, as recorded on the case outcomes page. */
export type OutcomeClass = "adverse" | "clean" | "unrecorded";

/** Fewer recorded outcomes than this and the split is not worth reading. */
export const MIN_OUTCOME_CASES = 3;

export interface CaseOutcomeRow {
  sessionId: string;
  delirium: string | null;
  emergence: string | null;
  awareness: boolean | null;
  unplannedIcu: boolean | null;
  mortality30d: boolean | null;
}

/**
 * Anything the recovery record flags as a problem counts as adverse; a row
 * that exists with nothing flagged counts as clean. No row at all is
 * unrecorded, and is never silently read as "went well".
 */
export function classifyOutcome(row: CaseOutcomeRow | null | undefined): OutcomeClass {
  if (!row) return "unrecorded";
  const delirium = (row.delirium ?? "none").toLowerCase();
  const emergence = (row.emergence ?? "smooth").toLowerCase();
  const adverse =
    (delirium !== "none" && delirium !== "unknown" && delirium !== "") ||
    (emergence !== "smooth" && emergence !== "unknown" && emergence !== "") ||
    row.awareness === true ||
    row.unplannedIcu === true ||
    row.mortality30d === true;
  return adverse ? "adverse" : "clean";
}

export interface PoolCase {
  sessionId: string;
  /** Opened case code where available, otherwise a short id. */
  caseCode: string | null;
  /** Paired monitor readings this case contributes to the fit. */
  readings: number;
  /** Scored epochs the recording holds, paired or not. */
  epochs: number;
  outcome: OutcomeClass;
  meanDepth: number | null;
  deepEpochs: number;
}

export interface HeadbandPool {
  lineageKey: string;
  points: CoebisTrainingPoint[];
  cases: PoolCase[];
  /** Paired readings in the pool. */
  readings: number;
  /** Cases contributing at least one paired reading. */
  pairedCases: number;
  /** Recordings on this lineage that hold EEG but no paired reading yet. */
  unpairedCases: number;
  casesWithOutcome: number;
  adverseCases: number;
}

export interface OutcomeStratum {
  outcome: OutcomeClass;
  cases: number;
  readings: number;
  /** Held-out agreement of the candidate on this group only. */
  agreement: AgreementSummary;
}

export interface OutcomeAwareFit extends HeadbandFit {
  /** Paired readings that came from a case with a recorded outcome. */
  readingsWithOutcome: number;
  casesWithOutcome: number;
  adverseCases: number;
  /** True once enough cases carry an outcome for the split to be readable. */
  outcomeUsable: boolean;
  /** Plain sentence about what the outcomes could and could not contribute. */
  outcomeNote: string;
  strata: OutcomeStratum[];
}

/** Assemble the pool: paired readings joined to their case and its outcome. */
export function buildHeadbandPool(
  lineageKey: string,
  points: CoebisTrainingPoint[],
  cases: {
    sessionId: string;
    caseCode: string | null;
    epochs: number;
    meanDepth: number | null;
    deepEpochs: number;
    outcome: CaseOutcomeRow | null;
  }[],
): HeadbandPool {
  const perCase = new Map<string, number>();
  for (const p of points) {
    const key = p.sessionId ?? "unfiled";
    perCase.set(key, (perCase.get(key) ?? 0) + 1);
  }
  const rows: PoolCase[] = cases.map((c) => ({
    sessionId: c.sessionId,
    caseCode: c.caseCode,
    readings: perCase.get(c.sessionId) ?? 0,
    epochs: c.epochs,
    outcome: classifyOutcome(c.outcome),
    meanDepth: c.meanDepth,
    deepEpochs: c.deepEpochs,
  }));
  rows.sort((a, b) => b.readings - a.readings || (a.caseCode ?? "").localeCompare(b.caseCode ?? ""));

  return {
    lineageKey,
    points,
    cases: rows,
    readings: points.length,
    pairedCases: rows.filter((r) => r.readings > 0).length,
    unpairedCases: rows.filter((r) => r.readings === 0).length,
    casesWithOutcome: rows.filter((r) => r.outcome !== "unrecorded").length,
    adverseCases: rows.filter((r) => r.outcome === "adverse").length,
  };
}

/** Leave-one-case-out predictions, kept per point so they can be grouped. */
function heldOutPredictions(
  points: CoebisTrainingPoint[],
): { point: CoebisTrainingPoint; predicted: number }[] {
  const keys = [...new Set(points.map((p) => p.sessionId ?? "unfiled"))];
  if (keys.length < 2) return [];
  const out: { point: CoebisTrainingPoint; predicted: number }[] = [];
  for (const key of keys) {
    const train = points.filter((p) => (p.sessionId ?? "unfiled") !== key);
    const test = points.filter((p) => (p.sessionId ?? "unfiled") === key);
    const model: CoebisModel | null = fitCoebisModel(train, "affine");
    if (!model) continue;
    for (const p of test) out.push({ point: p, predicted: predictCoebis(model, p, false) });
  }
  return out;
}

/**
 * Fit the headband lineage on its own paired readings and grade the result
 * against the cases' confirmed outcomes.
 */
export function refitHeadbandWithOutcomes(
  pool: HeadbandPool,
  incumbent: CoebisModel | null,
): OutcomeAwareFit {
  const base = refitHeadbandLineage(pool.lineageKey, pool.points, incumbent);
  const outcomeOf = new Map(pool.cases.map((c) => [c.sessionId, c.outcome] as const));
  const readingsWithOutcome = pool.points.filter(
    (p) => (outcomeOf.get(p.sessionId ?? "") ?? "unrecorded") !== "unrecorded",
  ).length;

  const held = heldOutPredictions(pool.points);
  const strata: OutcomeStratum[] = (["adverse", "clean", "unrecorded"] as OutcomeClass[]).map(
    (outcome) => {
      const rows = held.filter(
        (h) => (outcomeOf.get(h.point.sessionId ?? "") ?? "unrecorded") === outcome,
      );
      return {
        outcome,
        cases: new Set(rows.map((r) => r.point.sessionId ?? "unfiled")).size,
        readings: rows.length,
        agreement: agreementSummary(rows.map((r) => ({ predicted: r.predicted, bis: r.point.bis }))),
      };
    },
  );

  const outcomeUsable = pool.casesWithOutcome >= MIN_OUTCOME_CASES && pool.adverseCases > 0;
  const outcomeNote = !pool.casesWithOutcome
    ? `No recovery has been recorded for any of the ${pool.cases.length} bedside recordings, so the fit rests on the ${pool.readings} paired monitor readings alone. Record outcomes on the case outcomes page and the same fit will be graded against them.`
    : outcomeUsable
      ? `${pool.casesWithOutcome} of ${pool.cases.length} recordings carry a recorded recovery (${pool.adverseCases} with a problem). Outcomes grade the fit; they never set the target, which is always the monitor value.`
      : `Only ${pool.casesWithOutcome} of ${pool.cases.length} recordings carry a recorded recovery${
          pool.adverseCases ? "" : ", none with a problem"
        }; too few to read the split by outcome.`;

  return { ...base, readingsWithOutcome, casesWithOutcome: pool.casesWithOutcome, adverseCases: pool.adverseCases, outcomeUsable, outcomeNote, strata };
}
