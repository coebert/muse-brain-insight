/**
 * Scheduled COEBIS refit pipeline (pure core).
 *
 * A refit is only allowed to change the model people read numbers from if it
 * can be shown to help: every candidate is fitted per acquisition lineage on
 * validated readings only, scored leave-one-case-out, and compared against the
 * model currently in force on exactly the same data. Anything that does not
 * beat the incumbent by a clear margin is recorded as a version but never
 * promoted, so history stays auditable and the live model never silently
 * degrades.
 */

import {
  agreementSummary,
  crossValidateByCase,
  fitCoebisModel,
  predictCoebis,
  type AgreementSummary,
  type CoebisFamily,
  type CoebisModel,
  type CoebisTrainingPoint,
} from "./coebis-covariates";
import { MIN_POINTS, MIN_SESSIONS } from "./bis-drift";

/** Minimum signal quality a reading needs before it can train the model. */
export const MIN_TRAINING_SQI = 0.5;
/** Held-out MAE must improve by at least this much before a refit is promoted. */
export const MIN_MAE_GAIN = 0.25;
/** A promotion may not make agreement (CCC) worse by more than this. */
export const MAX_CCC_LOSS = 0.02;
/** Lineages processed in one scheduled run, so a run always terminates. */
export const MAX_LINEAGES_PER_RUN = 4;

export type RejectionReason =
  | "unreliable"
  | "low_sqi"
  | "out_of_range"
  | "not_finite"
  | "no_case";

export interface ValidationResult {
  used: CoebisTrainingPoint[];
  rejected: Record<RejectionReason, number>;
  /** Readings that passed, as a share of everything offered, 0–1. */
  passRate: number;
}

/** Keep only readings that are safe to learn from. */
export function selectValidatedPoints(points: CoebisTrainingPoint[]): ValidationResult {
  const rejected: Record<RejectionReason, number> = {
    unreliable: 0,
    low_sqi: 0,
    out_of_range: 0,
    not_finite: 0,
    no_case: 0,
  };
  const used: CoebisTrainingPoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.bis) || !Number.isFinite(p.appIndex)) {
      rejected.not_finite++;
      continue;
    }
    if (p.bis <= 0 || p.bis > 100 || p.appIndex < 0 || p.appIndex > 100) {
      rejected.out_of_range++;
      continue;
    }
    if (!p.sessionId) {
      rejected.no_case++;
      continue;
    }
    if (!p.reliable) {
      rejected.unreliable++;
      continue;
    }
    if (p.sqi != null && p.sqi < MIN_TRAINING_SQI) {
      rejected.low_sqi++;
      continue;
    }
    used.push(p);
  }
  return {
    used,
    rejected,
    passRate: points.length ? used.length / points.length : 0,
  };
}

/**
 * Deterministic fingerprint of a training set. Identical data yields an
 * identical digest, so a scheduled run that finds nothing new can skip the
 * refit instead of minting a duplicate version every night.
 */
export function dataFingerprint(points: CoebisTrainingPoint[]): string {
  const keys = points
    .map(
      (p) =>
        `${p.sessionId ?? "unfiled"}|${p.at.toFixed(2)}|${p.bis.toFixed(2)}|${p.appIndex.toFixed(2)}`,
    )
    .sort();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      h1 ^= key.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (Math.imul(h2 ^ key.charCodeAt(i), 0x85ebca6b) + 1) >>> 0;
    }
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}:${keys.length}`;
}

export interface LineageRefit {
  lineageKey: string;
  n: number;
  cases: number;
  family: CoebisFamily;
  digest: string;
  /** Enough validated data for this lineage to be fitted at all. */
  sufficient: boolean;
  /** Held-out agreement of the model currently in force, on this same data. */
  before: AgreementSummary;
  /** Whether `before` came from an incumbent model or the raw published index. */
  beforeSource: "incumbent" | "raw_index";
  /** Leave-one-case-out agreement of the candidate. */
  after: AgreementSummary;
  /** In-sample agreement of the candidate, for reference only. */
  inSample: AgreementSummary;
  folds: number;
  /** before.mae − after.mae; positive means the candidate is better. */
  maeGain: number | null;
  biasChange: number | null;
  promote: boolean;
  /** Why the candidate was or was not promoted. */
  reason: string;
  model: CoebisModel | null;
}

function scoreIncumbent(
  points: CoebisTrainingPoint[],
  incumbent: CoebisModel | null,
): { summary: AgreementSummary; source: "incumbent" | "raw_index" } {
  if (!incumbent) {
    return {
      summary: agreementSummary(points.map((p) => ({ predicted: p.appIndex, bis: p.bis }))),
      source: "raw_index",
    };
  }
  return {
    summary: agreementSummary(
      // `false` keeps per-case intercepts out: the incumbent never saw these
      // cases when it was fitted, so using them would flatter it.
      points.map((p) => ({ predicted: predictCoebis(incumbent, p, false), bis: p.bis })),
    ),
    source: "incumbent",
  };
}

function round(v: number | null, dp = 3): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

/** Fit and score one lineage's candidate model against the incumbent. */
export function refitLineage(
  lineageKey: string,
  points: CoebisTrainingPoint[],
  incumbent: CoebisModel | null,
  family: CoebisFamily = "covariate",
): LineageRefit {
  const cases = new Set(points.map((p) => p.sessionId ?? "unfiled")).size;
  const digest = dataFingerprint(points);
  const { summary: before, source: beforeSource } = scoreIncumbent(points, incumbent);
  const sufficient = points.length >= MIN_POINTS && cases >= MIN_SESSIONS;

  if (!sufficient) {
    return {
      lineageKey,
      n: points.length,
      cases,
      family,
      digest,
      sufficient: false,
      before,
      beforeSource,
      after: agreementSummary([]),
      inSample: agreementSummary([]),
      folds: 0,
      maeGain: null,
      biasChange: null,
      promote: false,
      reason: `Needs ${MIN_POINTS} validated readings across ${MIN_SESSIONS} cases; has ${points.length} across ${cases}.`,
      model: null,
    };
  }

  const cv = crossValidateByCase(points, family);
  const model = fitCoebisModel(points, family);
  const maeGain =
    before.mae != null && cv.outOfSample.mae != null ? round(before.mae - cv.outOfSample.mae, 3) : null;
  const biasChange =
    before.bias != null && cv.outOfSample.bias != null
      ? round(Math.abs(cv.outOfSample.bias) - Math.abs(before.bias), 3)
      : null;
  const cccLoss =
    before.ccc != null && cv.outOfSample.ccc != null ? before.ccc - cv.outOfSample.ccc : 0;

  let promote = false;
  let reason: string;
  if (!model) {
    reason = "Candidate model could not be fitted.";
  } else if (cv.folds < 2) {
    reason = "Not enough cases to cross-validate the candidate.";
  } else if (maeGain == null) {
    reason = "No comparable held-out error for the incumbent.";
  } else if (maeGain < MIN_MAE_GAIN) {
    reason = `Held-out error improves by only ${maeGain.toFixed(2)} points (needs ${MIN_MAE_GAIN}); keeping the current model.`;
  } else if (cccLoss > MAX_CCC_LOSS) {
    reason = `Error falls but agreement drops (CCC −${cccLoss.toFixed(3)}); not promoted.`;
  } else {
    promote = true;
    reason = `Held-out error falls ${maeGain.toFixed(2)} points (${before.mae?.toFixed(2)} → ${cv.outOfSample.mae?.toFixed(2)}) across ${cv.folds} folds.`;
  }

  return {
    lineageKey,
    n: points.length,
    cases,
    family,
    digest,
    sufficient: true,
    before,
    beforeSource,
    after: cv.outOfSample,
    inSample: cv.inSample,
    folds: cv.folds,
    maeGain,
    biasChange,
    promote,
    reason,
    model,
  };
}

export interface RefitPlanEntry {
  lineageKey: string;
  points: CoebisTrainingPoint[];
  digest: string;
  /** Digest of the data the newest version for this lineage was fitted on. */
  lastDigest: string | null;
  /** False when the data is unchanged since the last version. */
  changed: boolean;
}

export interface RefitPlan {
  entries: RefitPlanEntry[];
  /** Lineages left for the next run because of the per-run cap. */
  deferred: string[];
  skippedUnchanged: string[];
}

/**
 * Group validated readings by lineage and decide what this run should do.
 *
 * Lineages are never pooled: a model fitted across two acquisition setups is
 * fitting the average of two different measurements.
 */
export function planRefit(
  points: CoebisTrainingPoint[],
  lastDigests: Record<string, string | null>,
  maxLineages = MAX_LINEAGES_PER_RUN,
): RefitPlan {
  const byLineage = new Map<string, CoebisTrainingPoint[]>();
  for (const p of points) {
    const key = p.lineageKey?.trim() || "unlabelled";
    byLineage.set(key, [...(byLineage.get(key) ?? []), p]);
  }
  const ordered = [...byLineage.entries()].sort((a, b) => b[1].length - a[1].length);

  const entries: RefitPlanEntry[] = [];
  const deferred: string[] = [];
  const skippedUnchanged: string[] = [];
  for (const [lineageKey, list] of ordered) {
    const digest = dataFingerprint(list);
    const lastDigest = lastDigests[lineageKey] ?? null;
    if (lastDigest && lastDigest === digest) {
      skippedUnchanged.push(lineageKey);
      continue;
    }
    if (entries.length >= maxLineages) {
      deferred.push(lineageKey);
      continue;
    }
    entries.push({ lineageKey, points: list, digest, lastDigest, changed: true });
  }
  return { entries, deferred, skippedUnchanged };
}

/** One-line summary of a completed run, for the history list. */
export function summariseRun(refits: LineageRefit[]): string {
  if (!refits.length) return "No lineage had new validated data to refit.";
  const promoted = refits.filter((r) => r.promote);
  const parts = [
    `${refits.length} lineage${refits.length === 1 ? "" : "s"} refitted`,
    `${promoted.length} promoted`,
  ];
  const best = promoted.sort((a, b) => (b.maeGain ?? 0) - (a.maeGain ?? 0))[0];
  if (best) parts.push(`best gain ${best.maeGain?.toFixed(2)} points on ${best.lineageKey}`);
  return `${parts.join(", ")}.`;
}
