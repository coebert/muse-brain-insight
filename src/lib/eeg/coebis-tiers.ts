/**
 * COEBIS tiering — how much model the data can honestly support.
 *
 * A single global correction is safe at ten readings and wasteful at a
 * thousand; a per-case mixed model is right at a thousand and pure noise at
 * ten. Rather than choose once, COEBIS climbs a ladder: each tier needs a
 * minimum volume of paired readings across a minimum number of independent
 * cases, AND must beat the tier below it on leave-one-case-out error by a
 * margin. If it cannot, the simpler tier stays in force.
 *
 * Tier A — pooled affine + knot map (the original COEBIS).
 * Tier B — plus patient-specific corrections (age, sex, regimen, frailty).
 * Tier C — plus per-case random intercepts, which stop one long case from
 *          dictating the covariate terms.
 */

import {
  crossValidateByCase,
  fitCoebisModel,
  type CoebisCvResult,
  type CoebisFamily,
  type CoebisModel,
  type CoebisTrainingPoint,
} from "./coebis-covariates";
import type { CovariateTerm } from "./covariates";

export type CoebisTier = "A" | "B" | "C";

export interface TierSpec {
  tier: CoebisTier;
  family: CoebisFamily;
  label: string;
  description: string;
  minPoints: number;
  minCases: number;
}

export const COEBIS_TIERS: TierSpec[] = [
  {
    tier: "A",
    family: "affine",
    label: "Tier A — pooled",
    description: "One correction curve fitted across every case.",
    minPoints: 8,
    minCases: 2,
  },
  {
    tier: "B",
    family: "covariate",
    label: "Tier B — patient-adjusted",
    description: "Adds shrunk corrections for age band, sex, regimen and frailty.",
    minPoints: 60,
    minCases: 5,
  },
  {
    tier: "C",
    family: "mixed",
    label: "Tier C — mixed effects",
    description:
      "Adds a per-case intercept so correlated readings within one case cannot dominate the fit.",
    minPoints: 200,
    minCases: 15,
  },
];

/** Held-out error must fall by at least this much to justify a higher tier. */
export const MIN_TIER_GAIN = 0.2;
/** Fewer held-out folds than this and no tier above A can be trusted. */
export const MIN_TIER_FOLDS = 3;

export interface TierCandidate {
  tier: CoebisTier;
  family: CoebisFamily;
  label: string;
  /** Data volume clears the tier's entry bar. */
  eligible: boolean;
  points: { have: number; need: number };
  cases: { have: number; need: number };
  /** Leave-one-case-out mean absolute error, or null when unmeasurable. */
  mae: number | null;
  folds: number;
  /** Improvement over the tier currently selected below it. */
  gain: number | null;
  /** Why this tier was or was not taken, in one line. */
  reason: string;
}

export interface TierSelection {
  tier: CoebisTier;
  family: CoebisFamily;
  model: CoebisModel | null;
  terms: CovariateTerm[];
  candidates: TierCandidate[];
  cv: CoebisCvResult | null;
  /** Held-out MAE improvement of the chosen tier over Tier A. */
  gainOverPooled: number | null;
  note: string;
}

function countCases(points: CoebisTrainingPoint[]): number {
  return new Set(points.map((p) => p.sessionId ?? "unfiled")).size;
}

/**
 * Walk the ladder from the bottom, keeping the highest tier that both has the
 * data behind it and demonstrably generalises better than the tier in force.
 */
export function selectCoebisTier(points: CoebisTrainingPoint[]): TierSelection {
  const n = points.length;
  const cases = countCases(points);
  const cvCache = new Map<CoebisFamily, CoebisCvResult>();
  const cvFor = (family: CoebisFamily) => {
    const cached = cvCache.get(family);
    if (cached) return cached;
    const result = crossValidateByCase(points, family);
    cvCache.set(family, result);
    return result;
  };

  const candidates: TierCandidate[] = [];
  let chosen = COEBIS_TIERS[0]!;
  let chosenCv: CoebisCvResult | null = null;
  let bestMae: number | null = null;

  for (const spec of COEBIS_TIERS) {
    const eligible = n >= spec.minPoints && cases >= spec.minCases;
    const cv = eligible ? cvFor(spec.family) : null;
    const mae = cv?.outOfSample.mae ?? null;
    const gain = mae != null && bestMae != null ? Number((bestMae - mae).toFixed(2)) : null;

    let reason: string;
    if (!eligible) {
      reason = `Needs ${spec.minPoints} readings across ${spec.minCases} cases — have ${n} across ${cases}.`;
    } else if (spec.tier === "A") {
      reason = "In force as the baseline correction.";
      chosen = spec;
      chosenCv = cv;
      bestMae = mae;
    } else if (cv && cv.folds < MIN_TIER_FOLDS) {
      reason = `Only ${cv.folds} case${cv.folds === 1 ? "" : "s"} could be held out — not enough to test it.`;
    } else if (mae == null || gain == null) {
      reason = "Held-out error could not be measured.";
    } else if (gain < MIN_TIER_GAIN) {
      reason = `Held-out error ${gain <= 0 ? "no better than" : "only " + gain.toFixed(2) + " points better than"} the simpler model — not adopted.`;
    } else {
      reason = `Cuts held-out error by ${gain.toFixed(2)} index points — adopted.`;
      chosen = spec;
      chosenCv = cv;
      bestMae = mae;
    }

    candidates.push({
      tier: spec.tier,
      family: spec.family,
      label: spec.label,
      eligible,
      points: { have: n, need: spec.minPoints },
      cases: { have: cases, need: spec.minCases },
      mae,
      folds: cv?.folds ?? 0,
      gain,
      reason,
    });
  }

  const model = fitCoebisModel(points, chosen.family);
  const pooledMae = cvCache.get("affine")?.outOfSample.mae ?? null;
  const gainOverPooled =
    pooledMae != null && bestMae != null ? Number((pooledMae - bestMae).toFixed(2)) : null;

  const note =
    chosen.tier === "A"
      ? `Running ${chosen.label}: ${chosen.description}`
      : `Running ${chosen.label}${
          gainOverPooled != null && gainOverPooled > 0
            ? `, ${gainOverPooled.toFixed(2)} index points better than the pooled correction on cases it never saw`
            : ""
        }.`;

  return {
    tier: chosen.tier,
    family: chosen.family,
    model,
    terms: chosen.family === "affine" ? [] : (model?.terms ?? []),
    candidates,
    cv: chosenCv,
    gainOverPooled,
    note,
  };
}

/** Stored model label for a tier, e.g. `coebis-4` for the mixed fit. */
export function tierModelVersion(tier: CoebisTier, confirmed: boolean): string {
  const base = tier === "C" ? "coebis-4" : tier === "B" ? "coebis-3" : "coebis-2";
  return confirmed ? base : `${base}-provisional`;
}