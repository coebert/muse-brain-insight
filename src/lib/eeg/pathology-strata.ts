/**
 * Pathology-stratified evaluation of COEBIS.
 *
 * A single pooled bias hides the cases that matter most: a model can look
 * excellent overall while reading badly during burst suppression, in
 * seizure-like patterns, or under a regimen it has seen little of. This module
 * labels every paired reading with the electrophysiological pattern it was
 * taken in and the clinical labels of its case, then reports held-out bias and
 * error per stratum with an explicit sufficiency verdict, so a weak group is
 * visible rather than averaged away.
 */

import { agreementSummary, type AgreementSummary, type CoebisTrainingPoint } from "./coebis-covariates";

/** EEG pattern a reading was taken in, derived from the analysed epoch. */
export type EegPattern =
  | "burst_suppression"
  | "seizure_pattern"
  | "discontinuous"
  | "continuous"
  | "unknown";

/** What the analysed epoch nearest a paired reading looked like. */
export interface EpochContext {
  /** Suppression ratio at the reading, %. */
  suppressionRatio: number | null;
  isSuppressed: boolean | null;
  /** Seizure detector score, 0–1. */
  seizureScore: number | null;
}

/** A paired reading enriched with its pattern and clinical labels. */
export interface PathologyPoint extends CoebisTrainingPoint {
  epoch?: EpochContext | null;
  /** Care setting the case ran in (e.g. anaesthesia, icu). */
  careContext?: string | null;
  /** Free clinical feature labels recorded on the case. */
  clinicalFeatures?: string[];
}

export const SEIZURE_SCORE_THRESHOLD = 0.6;
export const SUPPRESSION_RATIO_THRESHOLD = 10;
export const DISCONTINUITY_RATIO_THRESHOLD = 1;

/** Minimum readings before a stratum's numbers are treated as more than a hint. */
export const MIN_STRATUM_READINGS = 15;
/** Minimum distinct cases before a stratum can claim to generalise. */
export const MIN_STRATUM_CASES = 3;

/** Classify the pattern a reading sits in. Suppression outranks a seizure score
 * because burst suppression itself drives the detector's score upwards. */
export function classifyPattern(epoch: EpochContext | null | undefined): EegPattern {
  if (!epoch) return "unknown";
  const sr = epoch.suppressionRatio;
  const seizure = epoch.seizureScore;
  if (epoch.isSuppressed === true || (sr != null && sr >= SUPPRESSION_RATIO_THRESHOLD)) {
    return "burst_suppression";
  }
  if (seizure != null && seizure >= SEIZURE_SCORE_THRESHOLD) return "seizure_pattern";
  if (sr != null && sr >= DISCONTINUITY_RATIO_THRESHOLD) return "discontinuous";
  if (sr != null || seizure != null) return "continuous";
  return "unknown";
}

export const PATTERN_LABELS: Record<EegPattern, string> = {
  burst_suppression: "Burst suppression",
  seizure_pattern: "Seizure-like pattern",
  discontinuous: "Discontinuous",
  continuous: "Continuous",
  unknown: "Pattern not recorded",
};

const GROUP_LABELS: Record<string, string> = {
  pattern: "EEG pattern",
  regimen: "Anaesthetic regimen",
  acute: "Acute pathology",
  chronicCns: "Chronic CNS disease",
  care: "Care setting",
  feature: "Clinical feature",
};

export function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group;
}

/** Every pathology-facing label a reading belongs to, as [group, level] pairs. */
export function pathologyLabels(point: PathologyPoint): [string, string][] {
  const out: [string, string][] = [];
  const pattern = classifyPattern(point.epoch ?? null);
  out.push(["pattern", PATTERN_LABELS[pattern]]);
  if (point.cov.regimen) out.push(["regimen", point.cov.regimen]);
  if (point.cov.acuteClass) out.push(["acute", point.cov.acuteClass]);
  if (point.cov.chronicCns) out.push(["chronicCns", point.cov.chronicCns]);
  const care = point.careContext ?? point.context;
  if (care) out.push(["care", care]);
  for (const f of point.clinicalFeatures ?? []) {
    if (typeof f === "string" && f.trim()) out.push(["feature", f.trim()]);
  }
  return out;
}

export interface PathologyStratum {
  group: string;
  groupLabel: string;
  level: string;
  /** Readings in the stratum. */
  n: number;
  /** Readings with a held-out prediction available. */
  scored: number;
  cases: number;
  /** Uncorrected app index vs monitor BIS. */
  before: AgreementSummary;
  /** Held-out COEBIS prediction vs monitor BIS. */
  after: AgreementSummary;
  /** 95% CI for the held-out bias, clustered by case. */
  biasCi: { low: number; high: number } | null;
  /** Bland–Altman limits of agreement on held-out error. */
  limitsOfAgreement: { low: number; high: number } | null;
  /** Held-out bias minus the overall held-out bias. */
  biasGap: number | null;
  /** Held-out MAE minus the overall held-out MAE. */
  maeGap: number | null;
  sufficiency: "sufficient" | "provisional" | "insufficient";
  /** Plain-language read on this stratum. */
  verdict: string;
}

export interface PathologyEvaluation {
  overall: AgreementSummary;
  overallBefore: AgreementSummary;
  points: number;
  scored: number;
  cases: number;
  strata: PathologyStratum[];
  /** Sufficient strata whose held-out error is materially worse than overall. */
  weakSpots: PathologyStratum[];
  /** Strata that need more data before they can be judged. */
  gaps: PathologyStratum[];
}

function round(v: number | null, dp = 2): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function sd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

function sufficiencyOf(n: number, cases: number): PathologyStratum["sufficiency"] {
  if (n >= MIN_STRATUM_READINGS && cases >= MIN_STRATUM_CASES) return "sufficient";
  if (n >= Math.ceil(MIN_STRATUM_READINGS / 3)) return "provisional";
  return "insufficient";
}

function verdictOf(s: Omit<PathologyStratum, "verdict">): string {
  if (s.sufficiency === "insufficient") {
    return `Too few readings (${s.n}) to judge this group.`;
  }
  const bias = s.after.bias;
  const gap = s.maeGap;
  const qualifier = s.sufficiency === "provisional" ? " Provisional: needs more cases." : "";
  if (bias == null || gap == null) return `No held-out prediction available yet.${qualifier}`;
  const direction = bias > 0 ? "reads lighter" : "reads deeper";
  if (gap > 3) return `Materially worse here: error ${gap.toFixed(1)} points above overall, ${direction} than the monitor.${qualifier}`;
  if (gap > 1.5) return `Somewhat worse here: error ${gap.toFixed(1)} points above overall.${qualifier}`;
  if (Math.abs(bias) > 5) return `Error in line with overall, but a persistent ${Math.abs(bias).toFixed(1)}-point bias (${direction}).${qualifier}`;
  return `Consistent with the overall model.${qualifier}`;
}

/**
 * Held-out agreement per pathology stratum.
 *
 * `predict` must return an out-of-fold prediction (a model fitted without that
 * reading's case) or null; in-sample predictions would flatter every group.
 */
export function evaluateByPathology(
  points: PathologyPoint[],
  predict: (point: PathologyPoint, index: number) => number | null,
): PathologyEvaluation {
  const predictions = points.map((p, i) => predict(p, i));
  const scoredPairs = points
    .map((p, i) => ({ predicted: predictions[i], bis: p.bis }))
    .filter((e): e is { predicted: number; bis: number } => e.predicted != null);
  const overall = agreementSummary(scoredPairs);
  const overallBefore = agreementSummary(points.map((p) => ({ predicted: p.appIndex, bis: p.bis })));

  const buckets = new Map<string, number[]>();
  points.forEach((p, i) => {
    for (const [group, level] of pathologyLabels(p)) {
      const key = `${group}\u0000${level}`;
      const list = buckets.get(key) ?? [];
      list.push(i);
      buckets.set(key, list);
    }
  });

  const strata: PathologyStratum[] = [...buckets.entries()].map(([key, indices]) => {
    const [group = "", level = ""] = key.split("\u0000");
    const list = indices.map((i) => points[i]!);
    const scoredEntries = indices
      .map((i) => ({ point: points[i]!, predicted: predictions[i] }))
      .filter((e): e is { point: PathologyPoint; predicted: number } => e.predicted != null);
    const after = agreementSummary(scoredEntries.map((e) => ({ predicted: e.predicted, bis: e.point.bis })));
    const before = agreementSummary(list.map((p) => ({ predicted: p.appIndex, bis: p.bis })));
    const diffs = scoredEntries.map((e) => e.predicted - e.point.bis);

    // Cluster the CI by case: consecutive readings within a case are far from
    // independent, so per-reading standard errors would be dishonestly tight.
    const perCase = new Map<string, number[]>();
    scoredEntries.forEach((e, idx) => {
      const k = e.point.sessionId ?? "unfiled";
      perCase.set(k, [...(perCase.get(k) ?? []), diffs[idx]!]);
    });
    const caseMeans = [...perCase.values()].map((v) => mean(v)!);
    const caseSd = sd(caseMeans);
    const bias = mean(diffs);
    const biasCi =
      bias != null && caseSd != null && caseMeans.length >= 2
        ? {
            low: round(bias - (1.96 * caseSd) / Math.sqrt(caseMeans.length))!,
            high: round(bias + (1.96 * caseSd) / Math.sqrt(caseMeans.length))!,
          }
        : null;
    const diffSd = sd(diffs);
    const limitsOfAgreement =
      bias != null && diffSd != null
        ? { low: round(bias - 1.96 * diffSd)!, high: round(bias + 1.96 * diffSd)! }
        : null;

    const cases = new Set(list.map((p) => p.sessionId ?? "unfiled")).size;
    const base: Omit<PathologyStratum, "verdict"> = {
      group,
      groupLabel: groupLabel(group),
      level,
      n: list.length,
      scored: scoredEntries.length,
      cases,
      before,
      after,
      biasCi,
      limitsOfAgreement,
      biasGap:
        after.bias != null && overall.bias != null ? round(after.bias - overall.bias) : null,
      maeGap: after.mae != null && overall.mae != null ? round(after.mae - overall.mae) : null,
      sufficiency: sufficiencyOf(list.length, cases),
    };
    return { ...base, verdict: verdictOf(base) };
  });

  strata.sort((a, b) =>
    a.group === b.group ? b.n - a.n : groupLabel(a.group).localeCompare(groupLabel(b.group)),
  );

  return {
    overall,
    overallBefore,
    points: points.length,
    scored: scoredPairs.length,
    cases: new Set(points.map((p) => p.sessionId ?? "unfiled")).size,
    strata,
    weakSpots: strata
      .filter((s) => s.sufficiency === "sufficient" && (s.maeGap ?? 0) > 1.5)
      .sort((a, b) => (b.maeGap ?? 0) - (a.maeGap ?? 0)),
    gaps: strata
      .filter((s) => s.sufficiency !== "sufficient")
      .sort((a, b) => b.n - a.n),
  };
}
