/**
 * External validation — train internally, benchmark per external lineage.
 *
 * The one thing an external dataset must never do is quietly join the training
 * pool. Every collection differs in montage, reference, drug regimen, era and
 * monitor, so pooling them makes the model better at guessing which dataset a
 * reading came from and worse at the patient in front of you. Held-out
 * external data is only useful as a *benchmark*.
 *
 * So the pipeline here is deliberately one-directional:
 *
 *   internal paired readings ──fit──► COEBIS / diagnostic thresholds
 *                                         │
 *                                         ├─ benchmark on lineage A
 *                                         ├─ benchmark on lineage B
 *                                         └─ … each scored separately
 *
 * Results are never averaged across lineages: a single pooled "external MAE"
 * hides the montage where the model fails. Each lineage keeps its own row, its
 * own n, and its own harmonisation record, so a weak result can be traced back
 * to the transform that produced it.
 *
 * Three benchmark kinds, matched to what a dataset actually contains:
 *
 *   • index-paired  — an app-computable index alongside a monitor value:
 *                     full COEBIS agreement (bias, MAE, CCC, within-5/10) plus Pk.
 *   • reference-only — monitor values, covariates and drug levels but no index
 *                     (VitalDB): scores only the covariate/Ce layer, as
 *                     calibration around that lineage's own mean.
 *   • spectral-label — DSA features with state labels (PhysioNet): scores the
 *                     diagnostic side — burst-suppression detection and the
 *                     depth ordering of SEF95.
 */

import {
  agreementSummary,
  predictCoebis,
  type AgreementSummary,
  type CoebisModel,
} from "./coebis-covariates";
import { ceAdjustment } from "./ce-terms";
import { covariateAdjustment, type CaseCovariates } from "./covariates";
import {
  predictionProbability,
  rocAnalysis,
  type PkResult,
  type RocResult,
} from "./discrimination";
import type { HarmonizationRecord } from "./harmonization";

/** Ordered clinical states used for Pk; larger = deeper. */
export const STATE_RANK: Record<string, number> = {
  awake: 0,
  sedated: 1,
  emergence: 1,
  anaesthetised: 2,
  suppression_burden: 3,
  burst_suppression: 4,
  isoelectric: 5,
};

export type BenchmarkKind = "index-paired" | "reference-only" | "spectral-label";

export interface IndexPairedPoint {
  caseRef: string;
  appIndex: number;
  bis: number;
  cov?: CaseCovariates | null;
  ce?: Record<string, number> | null;
  /** Clinical state when the dataset supplies one. */
  label?: string | null;
}

export interface ReferenceOnlyPoint {
  caseRef: string;
  bis: number;
  cov?: CaseCovariates | null;
  ce?: Record<string, number> | null;
}

export interface SpectralLabelPoint {
  caseRef: string;
  label: string | null;
  labelSource: "dataset" | "derived";
  suppressionRatio: number;
  isSuppressed: boolean;
  sef95: number;
}

export interface LineageBenchmark {
  lineage: string;
  kind: BenchmarkKind;
  n: number;
  cases: number;
  /** COEBIS agreement, for lineages that carry an index or a covariate layer. */
  agreement: AgreementSummary | null;
  /** Raw index against the monitor, so the benchmark shows what COEBIS added. */
  baseline: AgreementSummary | null;
  /** Ordering performance against the dataset's own state labels. */
  pk: PkResult | null;
  /** Burst-suppression detection against published labels. */
  suppressionRoc: RocResult | null;
  suppressionSensitivity: number | null;
  suppressionSpecificity: number | null;
  /** Harmonisation applied to this lineage before scoring, when recorded. */
  harmonization: HarmonizationRecord | null;
  /** Why a benchmark is missing or should be read with care. */
  notes: string[];
}

export interface ExternalValidationReport {
  /** Internal training set the benchmarked model was fitted on. */
  training: { n: number; cases: number; family: CoebisModel["family"] | null };
  /** One row per lineage — never pooled. */
  lineages: LineageBenchmark[];
  summary: string;
}

const round = (v: number | null, dp = 3) =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

/* ------------------------------------------------------ index-paired --- */

export function benchmarkIndexPaired(
  model: CoebisModel,
  lineage: string,
  points: IndexPairedPoint[],
  harmonization: HarmonizationRecord | null = null,
): LineageBenchmark {
  const notes: string[] = [];
  const usable = points.filter(
    (p) => Number.isFinite(p.appIndex) && Number.isFinite(p.bis),
  );
  // The case intercept is never used: this data was not in the fit, which is
  // exactly what makes the number external.
  const predicted = usable.map((p) => ({
    predicted: predictCoebis(model, { appIndex: p.appIndex, cov: p.cov ?? null, ce: p.ce ?? null }),
    bis: p.bis,
  }));
  const labelled = usable.filter((p) => p.label && p.label in STATE_RANK);
  if (usable.length < 20) notes.push("Fewer than 20 readings — treat as indicative only.");

  return {
    lineage,
    kind: "index-paired",
    n: usable.length,
    cases: new Set(usable.map((p) => p.caseRef)).size,
    agreement: agreementSummary(predicted),
    baseline: agreementSummary(usable.map((p) => ({ predicted: p.appIndex, bis: p.bis }))),
    pk: labelled.length
      ? predictionProbability(
          labelled.map((p) => ({
            value: predictCoebis(model, {
              appIndex: p.appIndex,
              cov: p.cov ?? null,
              ce: p.ce ?? null,
            }),
            rank: STATE_RANK[p.label!]!,
          })),
        )
      : null,
    suppressionRoc: null,
    suppressionSensitivity: null,
    suppressionSpecificity: null,
    harmonization,
    notes,
  };
}

/* ---------------------------------------------------- reference-only --- */

/**
 * Score only what such a dataset can actually test: whether the covariate and
 * effect-site layer moves the prediction in the right direction, relative to
 * that lineage's own mean. The absolute level is not scored, because there is
 * no app index behind it — pretending otherwise would grade the model against
 * a number it never produced.
 */
export function benchmarkReferenceOnly(
  model: CoebisModel,
  lineage: string,
  points: ReferenceOnlyPoint[],
  harmonization: HarmonizationRecord | null = null,
): LineageBenchmark {
  const notes = [
    "No app index in this collection — only the covariate/effect-site layer is scored, centred on the lineage mean.",
  ];
  const usable = points.filter((p) => Number.isFinite(p.bis));
  if (!usable.length) {
    return {
      lineage,
      kind: "reference-only",
      n: 0,
      cases: 0,
      agreement: null,
      baseline: null,
      pk: null,
      suppressionRoc: null,
      suppressionSensitivity: null,
      suppressionSpecificity: null,
      harmonization,
      notes: [...notes, "No usable readings."],
    };
  }

  const adjustments = usable.map(
    (p) =>
      covariateAdjustment(model.terms, p.cov ?? null).total +
      ceAdjustment(model.ceTerms, p.ce ?? null).total,
  );
  const meanBis = usable.reduce((a, p) => a + p.bis, 0) / usable.length;
  const meanAdj = adjustments.reduce((a, b) => a + b, 0) / adjustments.length;

  const predicted = usable.map((p, i) => ({
    predicted: meanBis + (adjustments[i]! - meanAdj),
    bis: p.bis,
  }));
  if (Math.abs(meanAdj - (adjustments[0] ?? 0)) < 1e-9 && new Set(adjustments).size === 1) {
    notes.push("Model applies no covariate or drug adjustment to this cohort.");
  }

  return {
    lineage,
    kind: "reference-only",
    n: usable.length,
    cases: new Set(usable.map((p) => p.caseRef)).size,
    agreement: agreementSummary(predicted),
    // The "baseline" is the flat lineage mean, i.e. no patient adjustment at all.
    baseline: agreementSummary(usable.map((p) => ({ predicted: meanBis, bis: p.bis }))),
    pk: null,
    suppressionRoc: null,
    suppressionSensitivity: null,
    suppressionSpecificity: null,
    harmonization,
    notes,
  };
}

/* --------------------------------------------------- spectral-label --- */

/**
 * Diagnostic-side benchmark: does the suppression detector agree with the
 * dataset's published labels, and does SEF95 order the published states?
 * Only dataset-published labels count as ground truth — scoring derived labels
 * against themselves would be circular.
 */
export function benchmarkSpectralLabels(
  lineage: string,
  points: SpectralLabelPoint[],
  harmonization: HarmonizationRecord | null = null,
): LineageBenchmark {
  const notes: string[] = [];
  const truth = points.filter((p) => p.labelSource === "dataset" && p.label);
  if (!truth.length) {
    notes.push(
      "No dataset-published labels in this lineage — labels here were derived by this app, so they cannot serve as ground truth.",
    );
  }

  const suppressionCases = truth.filter((p) => p.label! in STATE_RANK);
  const positives = suppressionCases.filter(
    (p) => p.label === "burst_suppression" || p.label === "isoelectric",
  );
  const negatives = suppressionCases.filter(
    (p) => !(p.label === "burst_suppression" || p.label === "isoelectric"),
  );

  let sensitivity: number | null = null;
  let specificity: number | null = null;
  if (positives.length && negatives.length) {
    sensitivity = round(positives.filter((p) => p.isSuppressed).length / positives.length);
    specificity = round(negatives.filter((p) => !p.isSuppressed).length / negatives.length);
  } else if (truth.length) {
    notes.push("Labels do not span both suppressed and non-suppressed states.");
  }

  const roc =
    positives.length && negatives.length
      ? rocAnalysis(
          suppressionCases.map((p) => ({
            // ROC convention here is "lower value = deeper", so score on the
            // inverse of the suppression ratio.
            value: 100 - p.suppressionRatio,
            positive: p.label === "burst_suppression" || p.label === "isoelectric",
          })),
        )
      : null;

  const ranked = truth.filter((p) => p.label! in STATE_RANK);
  const pk = ranked.length
    ? predictionProbability(ranked.map((p) => ({ value: p.sef95, rank: STATE_RANK[p.label!]! })))
    : null;

  return {
    lineage,
    kind: "spectral-label",
    n: points.length,
    cases: new Set(points.map((p) => p.caseRef)).size,
    agreement: null,
    baseline: null,
    pk,
    suppressionRoc: roc,
    suppressionSensitivity: sensitivity,
    suppressionSpecificity: specificity,
    harmonization,
    notes,
  };
}

/* -------------------------------------------------------------- report --- */

export function summariseExternalValidation(
  training: ExternalValidationReport["training"],
  lineages: LineageBenchmark[],
): string {
  if (!training.n) return "No internal paired readings yet, so no model could be trained to benchmark.";
  if (!lineages.length) {
    return `Trained on ${training.n} internal readings from ${training.cases} case(s); no external lineage has data to benchmark against yet.`;
  }
  const parts = lineages.map((l) => {
    if (l.kind === "spectral-label") {
      const sens = l.suppressionSensitivity;
      const spec = l.suppressionSpecificity;
      return sens != null && spec != null
        ? `${l.lineage}: burst-suppression sensitivity ${(sens * 100).toFixed(0)}%, specificity ${(spec * 100).toFixed(0)}% (n = ${l.n})`
        : `${l.lineage}: no labelled suppression to score (n = ${l.n})`;
    }
    const mae = l.agreement?.mae;
    const base = l.baseline?.mae;
    const delta =
      mae != null && base != null
        ? `${base - mae >= 0 ? "improves on" : "is worse than"} the unadjusted baseline by ${Math.abs(base - mae).toFixed(2)}`
        : "no comparison available";
    return `${l.lineage}: MAE ${mae ?? "—"} (n = ${l.n}, ${delta})`;
  });
  return (
    `Trained on ${training.n} internal readings from ${training.cases} case(s), then scored separately on ` +
    `${lineages.length} external lineage(s). ${parts.join("; ")}. Figures are never pooled across lineages.`
  );
}

export function buildExternalValidationReport(
  training: ExternalValidationReport["training"],
  lineages: LineageBenchmark[],
): ExternalValidationReport {
  const sorted = [...lineages].sort((a, b) => b.n - a.n);
  return { training, lineages: sorted, summary: summariseExternalValidation(training, sorted) };
}
