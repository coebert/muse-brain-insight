/**
 * Pathology dashboard: model output versus *recorded* labels.
 *
 * `pathology-strata.ts` grades COEBIS inside groups the app itself derived
 * (detector pattern, covariates). That is circular for the question clinicians
 * actually ask: does the index separate patients whose seizure or CNS disease
 * status was established independently of the app? This module only ever uses
 * labels that came from outside the analysis path — a dataset's own annotation
 * or a clinician's marked event — and grades every stored score against them.
 *
 * Three deliberate constraints:
 *  - Suppression is treated as a confounder, not an outcome. Burst suppression
 *    lifts the seizure detector and drops the depth index on its own, so every
 *    axis is also reported inside suppression bands.
 *  - Discrimination is reported with the sample's own prevalence, and posterior
 *    value (PPV/NPV) is only ever quoted against an explicit prior. A detector
 *    with AUC 0.9 is close to useless at a 1-in-500 prior, and the dashboard
 *    should say so rather than flatter the model.
 *  - Nothing is called reliable without independent cases; per-second epochs
 *    from one recording are not independent evidence.
 */

import { rocAnalysis, type RocResult } from "./discrimination";

export type SeizureLabel = "ictal" | "interictal";

/** Where a label came from. Anything the app derived is excluded upstream. */
export type LabelSource = "dataset" | "clinician" | "monitor";

/** Burst suppression as a *recorded* fact (bedside monitor SR, dataset annotation). */
export type SuppressionLabel = "suppressed" | "not_suppressed";

/** Anaesthetic state a dataset's own event file establishes. */
export type DepthStateLabel = "awake" | "induction" | "anaesthetised" | "emergence";

/** Monitor SR at or above this percent is recorded burst suppression. */
export const MONITOR_SUPPRESSED_PCT = 5;
/** Monitor SR at or below this percent is a recorded clear (non-suppressed) epoch.
 * The band between the two is ambiguous and is discarded rather than guessed. */
export const MONITOR_CLEAR_PCT = 1;


export type ScoreKey =
  | "coebis"
  | "coebisDrugCorrected"
  | "seizureScore"
  | "suppressionRatio"
  | "sef95"
  | "stateEntropy"
  | "responseEntropy"
  | "betaRatio"
  | "alphaDelta";

/** Comparators recomputed from the published algorithm, not quoted from a paper. */
export const COMPARATOR_SCORES: ScoreKey[] = [
  "stateEntropy",
  "responseEntropy",
  "betaRatio",
  "alphaDelta",
  "sef95",
];


export interface ScoreMeta {
  key: ScoreKey;
  label: string;
  unit: string;
  dp: number;
  /** Which direction of the score marks the positive (pathological) class. */
  direction: "higher" | "lower";
  note: string;
}

export const SCORE_META: ScoreMeta[] = [
  {
    key: "seizureScore",
    label: "Seizure score",
    unit: "",
    dp: 2,
    direction: "higher",
    note: "Rhythmicity/evolution detector output, 0–1.",
  },
  {
    key: "coebis",
    label: "COEBIS index",
    unit: "pts",
    dp: 1,
    direction: "lower",
    note: "Depth index; lower means deeper, so pathological slowing reads low.",
  },
  {
    key: "coebisDrugCorrected",
    label: "COEBIS (drug-corrected)",
    unit: "pts",
    dp: 1,
    direction: "lower",
    note: "Depth index after the recorded agents' EEG signatures are subtracted.",
  },
  {
    key: "suppressionRatio",
    label: "Suppression ratio",
    unit: "%",
    dp: 1,
    direction: "higher",
    note: "Confounder as much as a marker: sedation alone raises it.",
  },
  {
    key: "sef95",
    label: "SEF95",
    unit: "Hz",
    dp: 1,
    direction: "lower",
    note: "Spectral edge; falls with slowing from any cause.",
  },
  {
    key: "stateEntropy",
    label: "State Entropy (published)",
    unit: "",
    dp: 1,
    direction: "lower",
    note: "GE/Datex M-Entropy SE, 0.8–32 Hz, recomputed from this epoch's spectrum.",
  },
  {
    key: "responseEntropy",
    label: "Response Entropy (published)",
    unit: "",
    dp: 1,
    direction: "lower",
    note: "M-Entropy RE, 0.8–47 Hz; includes frontal EMG.",
  },
  {
    key: "betaRatio",
    label: "Beta ratio (published)",
    unit: "log",
    dp: 2,
    direction: "lower",
    note: "Rampil's BIS subparameter log10(P30–47 / P11–20). Not the BIS composite.",
  },
  {
    key: "alphaDelta",
    label: "Alpha/delta ratio (published)",
    unit: "dB",
    dp: 1,
    direction: "lower",
    note: "Standard ICU quantitative-EEG depth marker.",
  },
];

export interface EpochScores {
  coebis: number | null;
  /**
   * COEBIS after the recorded agents' EEG signatures are subtracted. Present
   * only where the case names its drugs and the epoch keeps band powers; the
   * benchmark falls back to the raw index elsewhere rather than imputing.
   */
  coebisDrugCorrected?: number | null;
  seizureScore: number | null;
  suppressionRatio: number | null;
  sef95: number | null;
  /** Published comparators, recomputed from the stored spectrum where one exists. */
  stateEntropy?: number | null;
  responseEntropy?: number | null;
  betaRatio?: number | null;
  alphaDelta?: number | null;

}

/** One analysed epoch carrying at least one independently recorded label. */
export interface LabelledEpoch {
  lineage: string;
  caseRef: string;
  atSeconds: number;
  labelSource: LabelSource;
  /** Dataset- or clinician-established ictal status, when known. */
  seizure: SeizureLabel | null;
  /** Recorded CNS disease category, e.g. "seizure_disorder", "stroke", "none". */
  cns: string | null;
  /** Burst suppression established by a bedside monitor or dataset annotation. */
  suppression?: SuppressionLabel | null;
  /** Anaesthetic state established by a dataset's event file. */
  state?: DepthStateLabel | null;
  scores: EpochScores;
}


/** Minimum labelled epochs before a number is more than a hint. */
export const MIN_AXIS_EPOCHS = 40;
/** Minimum independent cases on each side of the label before it generalises. */
export const MIN_AXIS_CASES = 3;

export const SUPPRESSION_BANDS = [
  { key: "none", label: "No suppression (<1%)", low: 0, high: 1 },
  { key: "light", label: "Light (1–10%)", low: 1, high: 10 },
  { key: "moderate", label: "Moderate (10–30%)", low: 10, high: 30 },
  { key: "deep", label: "Deep (≥30%)", low: 30, high: Number.POSITIVE_INFINITY },
] as const;

export type Sufficiency = "sufficient" | "provisional" | "insufficient";

export interface ScoreDiscrimination {
  score: ScoreKey;
  scoreLabel: string;
  direction: "higher" | "lower";
  n: number;
  positives: number;
  negatives: number;
  positiveCases: number;
  negativeCases: number;
  auc: number | null;
  aucCi: { low: number; high: number } | null;
  /** Youden-optimal operating point on this sample. */
  operating: {
    threshold: number;
    sensitivity: number;
    specificity: number;
    lrPositive: number | null;
    lrNegative: number | null;
  } | null;
  /** Mean score in each class, for a plain read of the separation. */
  meanPositive: number | null;
  meanNegative: number | null;
  sufficiency: Sufficiency;
  verdict: string;
}

export interface SuppressionStratum {
  key: string;
  label: string;
  n: number;
  positives: number;
  cases: number;
  /** AUC of the axis's lead score inside this suppression band. */
  auc: number | null;
  meanSuppression: number | null;
  sufficiency: Sufficiency;
}

export interface LabelAxis {
  key: string;
  label: string;
  positiveLabel: string;
  negativeLabel: string;
  description: string;
  labelSources: LabelSource[];
  lineages: string[];
  n: number;
  positives: number;
  cases: number;
  /** Observed prevalence in the labelled sample — the sample's own prior. */
  samplePrevalence: number | null;
  /** Case-level prevalence, which is the honest prior for a new patient. */
  casePrevalence: number | null;
  scores: ScoreDiscrimination[];
  /** The best-discriminating score with sufficient data, if any. */
  leadScore: ScoreKey | null;
  suppression: SuppressionStratum[];
  /** Mean suppression ratio in each class — confounding check. */
  suppressionPositive: number | null;
  suppressionNegative: number | null;
  /** COEBIS against the best published comparator on exactly these epochs. */
  benchmark: ComparatorBenchmark | null;
  sufficiency: Sufficiency;
  verdict: string;
}

/** Head-to-head between COEBIS and the published indices on one axis. */
export interface ComparatorBenchmark {
  /** Epochs where COEBIS and the comparators are both available. */
  n: number;
  cases: number;
  coebisAuc: number | null;
  bestComparator: ScoreKey | null;
  bestComparatorLabel: string | null;
  bestComparatorAuc: number | null;
  /** COEBIS AUC minus the best comparator's, on the paired subset. */
  delta: number | null;
  /**
   * The same grading run on the drug-corrected index. Epochs without a
   * correction carry the raw index, so this is the same subset, never an
   * easier one.
   */
  correctedAuc: number | null;
  /** Epochs on the subset where a correction actually moved the index. */
  correctedEpochs: number;
  /** Mean absolute movement the corrections applied, in index points. */
  meanCorrection: number | null;
  /** Drug-corrected AUC minus the raw COEBIS AUC. */
  correctionDelta: number | null;
  /** Drug-corrected AUC minus the best published comparator's. */
  correctedVsBest: number | null;
  /** Every comparator's AUC on the same paired subset, best first. */
  comparators: ComparatorScore[];
  /** Suppression, read on exactly the same epochs as the depth comparison. */
  suppressionOnSubset: SubsetSuppression;
  /** Recorded BIS, read on exactly the same epochs as the depth comparison. */
  bisOnSubset: SubsetBis;
  sufficiency: Sufficiency;
  verdict: string;
}

/**
 * COEBIS against the published bedside BIS number on the benchmark's own
 * epochs. Only epochs whose paired reading carries a recorded BIS value count;
 * nothing is imputed, and where no epoch carries one the panel says so rather
 * than grading against a substitute.
 */
export interface SubsetBis {
  /** Benchmark epochs carrying a recorded BIS value. */
  n: number;
  cases: number;
  meanBis: number | null;
  meanCoebis: number | null;
  /** Mean absolute COEBIS − BIS, in index points. */
  mae: number | null;
  /** Mean signed COEBIS − BIS: negative means COEBIS reads deeper. */
  bias: number | null;
  /** Pearson correlation between COEBIS and BIS on these epochs. */
  correlation: number | null;
  /** The same three numbers for the drug-corrected index. */
  correctedMae: number | null;
  correctedBias: number | null;
  correctedCorrelation: number | null;
  /** Epochs where a drug correction actually moved the index. */
  correctedEpochs: number;
  sufficiency: Sufficiency;
  verdict: string;
}


/**
 * What suppression is doing on the benchmark's own epochs.
 *
 * Where those epochs carry a recorded suppression label (a bedside monitor's
 * own suppression ratio, or a dataset annotation) the same indices are graded
 * against it, so depth and suppression are read on one sample rather than two.
 * Where they do not, the panel says so and reports only the app's measured
 * suppression, which is a confounder read and not a grade.
 */
export interface SubsetSuppression {
  /** Epochs on the benchmark subset carrying a recorded suppression label. */
  labelled: number;
  suppressed: number;
  clear: number;
  cases: number;
  /** App suppression ratio graded against the recorded label. */
  appAuc: number | null;
  /** COEBIS graded against the recorded suppression label. */
  coebisAuc: number | null;
  /** Drug-corrected COEBIS graded against the recorded suppression label. */
  correctedAuc: number | null;
  /** Mean app-measured suppression over the whole benchmark subset. */
  meanAppSuppression: number | null;
  /** Benchmark epochs where the app measured any suppression at all (≥1%). */
  appFlagged: number;
  sufficiency: Sufficiency;
  verdict: string;
}


export interface ComparatorScore {
  score: ScoreKey;
  label: string;
  /** AUC at the index's published orientation (e.g. entropy falls with depth). */
  auc: number | null;
  /**
   * Discrimination regardless of sign, max(AUC, 1-AUC). An index whose
   * published direction is reversed on this sample still separates the groups
   * — propofol alpha spindles invert the alpha/delta ratio, for instance — and
   * hiding that would flatter COEBIS.
   */
  orientedAuc: number | null;
  /** True when the published direction is reversed on this sample. */
  inverted: boolean;
}




export interface LineageInventory {
  lineage: string;
  epochs: number;
  cases: number;
  seizureLabelled: number;
  ictal: number;
  cnsLabelled: number;
  /** Epochs whose burst suppression was recorded, not computed by the app. */
  suppressionLabelled: number;
  suppressed: number;
  /** Epochs carrying a dataset event-derived anaesthetic state. */
  stateLabelled: number;

  labelSources: LabelSource[];
  scoresPresent: ScoreKey[];
}

export interface PathologyLabelEvaluation {
  generatedAt: string;
  totalEpochs: number;
  labelledEpochs: number;
  lineages: LineageInventory[];
  axes: LabelAxis[];
  /** Honest statements about what the data cannot yet support. */
  notes: string[];
}

function round(v: number | null, dp = 3): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function sufficiencyOf(n: number, posCases: number, negCases: number): Sufficiency {
  if (n >= MIN_AXIS_EPOCHS && posCases >= MIN_AXIS_CASES && negCases >= MIN_AXIS_CASES) {
    return "sufficient";
  }
  if (n >= Math.ceil(MIN_AXIS_EPOCHS / 4) && posCases >= 1 && negCases >= 1) return "provisional";
  return "insufficient";
}

/**
 * ROC with an explicit direction. `rocAnalysis` scores "lower value = positive",
 * so a higher-is-worse score is negated and its thresholds mapped back.
 */
export function directionalRoc(
  values: { value: number; positive: boolean }[],
  direction: "higher" | "lower",
): RocResult {
  if (direction === "lower") return rocAnalysis(values);
  const flipped = rocAnalysis(values.map((v) => ({ value: -v.value, positive: v.positive })));
  return {
    ...flipped,
    bestThreshold: flipped.bestThreshold == null ? null : -flipped.bestThreshold,
    curve: flipped.curve.map((p) => ({ ...p, threshold: -p.threshold })),
  };
}

/** Hanley–McNeil standard error, widened to case count so clustered epochs
 * cannot pretend to be independent observations. */
function aucCi(
  auc: number,
  nPos: number,
  nNeg: number,
  posCases: number,
  negCases: number,
): { low: number; high: number } | null {
  if (!nPos || !nNeg) return null;
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  // Deflate the effective sample size to the number of independent cases.
  const ePos = Math.max(1, Math.min(nPos, posCases));
  const eNeg = Math.max(1, Math.min(nNeg, negCases));
  const variance =
    (auc * (1 - auc) + (ePos - 1) * (q1 - auc * auc) + (eNeg - 1) * (q2 - auc * auc)) /
    (ePos * eNeg);
  if (!(variance > 0)) return null;
  const se = Math.sqrt(variance);
  return {
    low: round(Math.max(0, auc - 1.96 * se), 3)!,
    high: round(Math.min(1, auc + 1.96 * se), 3)!,
  };
}

function discriminationVerdict(d: Omit<ScoreDiscrimination, "verdict">): string {
  if (d.sufficiency === "insufficient") {
    return `Only ${d.positives} labelled positive epochs across ${d.positiveCases} case(s) — not gradeable.`;
  }
  if (d.auc == null) return "One class is missing, so discrimination cannot be measured.";
  const qualifier =
    d.sufficiency === "provisional" ? " Provisional: too few independent cases." : "";
  const band =
    d.auc >= 0.9
      ? "strong separation"
      : d.auc >= 0.8
        ? "useful separation"
        : d.auc >= 0.7
          ? "modest separation"
          : d.auc >= 0.6
            ? "weak separation"
            : "no better than chance";
  const ci = d.aucCi ? ` (95% CI ${d.aucCi.low.toFixed(2)}–${d.aucCi.high.toFixed(2)})` : "";
  const chance = d.aucCi && d.aucCi.low <= 0.5 ? " The interval includes chance." : "";
  return `AUC ${d.auc.toFixed(2)}${ci} — ${band}.${chance}${qualifier}`;
}

function discriminate(
  epochs: LabelledEpoch[],
  isPositive: (e: LabelledEpoch) => boolean,
  meta: ScoreMeta,
): ScoreDiscrimination | null {
  const usable = epochs.filter((e) => {
    const v = e.scores[meta.key];
    return typeof v === "number" && Number.isFinite(v);
  });
  if (!usable.length) return null;
  const values = usable.map((e) => ({ value: e.scores[meta.key] as number, positive: isPositive(e) }));
  const roc = directionalRoc(values, meta.direction);
  const posCases = new Set(usable.filter(isPositive).map((e) => e.caseRef)).size;
  const negCases = new Set(usable.filter((e) => !isPositive(e)).map((e) => e.caseRef)).size;
  const sufficiency = sufficiencyOf(usable.length, posCases, negCases);

  let operating: ScoreDiscrimination["operating"] = null;
  if (roc.bestThreshold != null) {
    const point = roc.curve.find((p) => p.threshold === roc.bestThreshold);
    if (point) {
      const sens = point.sensitivity;
      const spec = point.specificity;
      operating = {
        threshold: round(roc.bestThreshold, meta.dp)!,
        sensitivity: round(sens, 3)!,
        specificity: round(spec, 3)!,
        lrPositive: spec < 1 ? round(sens / (1 - spec), 2) : null,
        lrNegative: spec > 0 ? round((1 - sens) / spec, 2) : null,
      };
    }
  }

  const base: Omit<ScoreDiscrimination, "verdict"> = {
    score: meta.key,
    scoreLabel: meta.label,
    direction: meta.direction,
    n: usable.length,
    positives: roc.nPositive,
    negatives: roc.nNegative,
    positiveCases: posCases,
    negativeCases: negCases,
    auc: roc.auc,
    aucCi:
      roc.auc == null ? null : aucCi(roc.auc, roc.nPositive, roc.nNegative, posCases, negCases),
    operating,
    meanPositive: round(
      mean(values.filter((v) => v.positive).map((v) => v.value)),
      meta.dp,
    ),
    meanNegative: round(
      mean(values.filter((v) => !v.positive).map((v) => v.value)),
      meta.dp,
    ),
    sufficiency,
  };
  return { ...base, verdict: discriminationVerdict(base) };
}

function suppressionStrata(
  epochs: LabelledEpoch[],
  isPositive: (e: LabelledEpoch) => boolean,
  lead: ScoreMeta | null,
): SuppressionStratum[] {
  return SUPPRESSION_BANDS.map((band) => {
    const inBand = epochs.filter((e) => {
      const sr = e.scores.suppressionRatio;
      return sr != null && Number.isFinite(sr) && sr >= band.low && sr < band.high;
    });
    const positives = inBand.filter(isPositive).length;
    const posCases = new Set(inBand.filter(isPositive).map((e) => e.caseRef)).size;
    const negCases = new Set(inBand.filter((e) => !isPositive(e)).map((e) => e.caseRef)).size;
    const auc = lead
      ? directionalRoc(
          inBand
            .filter((e) => e.scores[lead.key] != null)
            .map((e) => ({ value: e.scores[lead.key] as number, positive: isPositive(e) })),
          lead.direction,
        ).auc
      : null;
    return {
      key: band.key,
      label: band.label,
      n: inBand.length,
      positives,
      cases: new Set(inBand.map((e) => e.caseRef)).size,
      auc,
      meanSuppression: round(
        mean(inBand.map((e) => e.scores.suppressionRatio!).filter((v) => Number.isFinite(v))),
        1,
      ),
      sufficiency: sufficiencyOf(inBand.length, posCases, negCases),
    };
  }).filter((s) => s.n > 0);
}

function axisVerdict(axis: Omit<LabelAxis, "verdict">): string {
  if (axis.sufficiency === "insufficient") {
    return `${axis.positives} labelled ${axis.positiveLabel} epochs across ${axis.cases} case(s): enough to display, not to conclude.`;
  }
  const lead = axis.scores.find((s) => s.score === axis.leadScore);
  if (!lead || lead.auc == null) return "No stored score separates these labels yet.";
  const confound =
    axis.suppressionPositive != null &&
    axis.suppressionNegative != null &&
    Math.abs(axis.suppressionPositive - axis.suppressionNegative) > 5
      ? ` Suppression differs between the groups (${axis.suppressionPositive.toFixed(1)}% vs ${axis.suppressionNegative.toFixed(1)}%), so part of this separation may be sedation depth rather than pathology.`
      : "";
  const bench = axis.benchmark ? ` ${axis.benchmark.verdict}` : "";
  return `${lead.scoreLabel} leads at AUC ${lead.auc.toFixed(2)}.${confound}${bench}`;

}

/**
 * Suppression read on the benchmark's own epochs, so the depth comparison and
 * the suppression grading are never quoted off two different samples.
 */
export function subsetSuppression(
  subset: LabelledEpoch[],
  correctedValue: (e: LabelledEpoch) => number,
): SubsetSuppression {
  const srValues = subset
    .map((e) => e.scores.suppressionRatio)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const meanAppSuppression = round(mean(srValues), 2);
  const appFlagged = srValues.filter((v) => v >= 1).length;

  const labelled = subset.filter((e) => e.suppression != null);
  const suppressed = labelled.filter((e) => e.suppression === "suppressed");
  const clear = labelled.filter((e) => e.suppression === "not_suppressed");
  const cases = new Set(labelled.map((e) => e.caseRef)).size;
  const posCases = new Set(suppressed.map((e) => e.caseRef)).size;
  const negCases = new Set(clear.map((e) => e.caseRef)).size;
  const sufficiency = sufficiencyOf(labelled.length, posCases, negCases);

  const gradeable = suppressed.length > 0 && clear.length > 0;
  const isSuppressed = (e: LabelledEpoch) => e.suppression === "suppressed";
  const auc = (
    pick: (e: LabelledEpoch) => number | null,
    direction: "higher" | "lower",
  ): number | null => {
    if (!gradeable) return null;
    const values = labelled
      .map((e) => ({ value: pick(e), positive: isSuppressed(e) }))
      .filter((v): v is { value: number; positive: boolean } => v.value != null);
    if (!values.some((v) => v.positive) || !values.some((v) => !v.positive)) return null;
    return round(directionalRoc(values, direction).auc, 3);
  };

  const appAuc = auc((e) => e.scores.suppressionRatio ?? null, "higher");
  const coebisAuc = auc((e) => e.scores.coebis ?? null, "lower");
  const correctedAuc = auc((e) => correctedValue(e), "lower");

  const verdict = (() => {
    const measured =
      meanAppSuppression == null
        ? "The app recorded no suppression figure on these epochs."
        : `The app measured ${meanAppSuppression.toFixed(1)}% suppression on average across the ${subset.length} benchmark epochs, with ${appFlagged} above 1%.`;
    if (!labelled.length) {
      return `${measured} None of them carries a monitor- or dataset-recorded suppression label, so suppression cannot be graded on this exact sample; the recorded-suppression axis grades it on the bedside-monitor recordings instead.`;
    }
    if (!gradeable) {
      return `${measured} ${labelled.length} carry a recorded suppression label but only one class is present, so only one side of the grading is measurable.`;
    }
    const parts = [
      appAuc == null ? null : `app suppression AUC ${appAuc.toFixed(2)}`,
      coebisAuc == null ? null : `COEBIS ${coebisAuc.toFixed(2)}`,
      correctedAuc == null ? null : `drug-corrected ${correctedAuc.toFixed(2)}`,
    ].filter(Boolean);
    const qualifier =
      sufficiency === "sufficient"
        ? ""
        : ` Provisional: ${posCases} suppressed and ${negCases} clear case(s).`;
    return `${measured} Against the ${suppressed.length} recorded suppressed and ${clear.length} clear epochs on this same subset: ${parts.join(", ")}.${qualifier}`;
  })();

  return {
    labelled: labelled.length,
    suppressed: suppressed.length,
    clear: clear.length,
    cases,
    appAuc,
    coebisAuc,
    correctedAuc,
    meanAppSuppression,
    appFlagged,
    sufficiency,
    verdict,
  };
}


/**
 * COEBIS against the published comparators on *identical* epochs.
 *
 * Every index is graded on the one subset where COEBIS and each usable
 * comparator are all present, so a comparator cannot look better simply by
 * being defined on an easier slice of the recording. Comparators that are
 * missing from most of the labelled epochs (no stored spectrum for that
 * lineage, typically) are dropped rather than imputed.
 */
export function comparatorBenchmark(
  epochs: LabelledEpoch[],
  isPositive: (e: LabelledEpoch) => boolean,
): ComparatorBenchmark | null {
  const value = (e: LabelledEpoch, key: ScoreKey): number | null => {
    const v = e.scores[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const withCoebis = epochs.filter((e) => value(e, "coebis") != null);
  if (!withCoebis.length) return null;

  const usable = COMPARATOR_SCORES.filter(
    (key) => withCoebis.filter((e) => value(e, key) != null).length >= MIN_AXIS_EPOCHS,
  );
  if (!usable.length) return null;

  const subset = withCoebis.filter((e) => usable.every((key) => value(e, key) != null));
  if (!subset.length) return null;

  const positives = subset.filter(isPositive);
  const negatives = subset.filter((e) => !isPositive(e));
  const posCases = new Set(positives.map((e) => e.caseRef)).size;
  const negCases = new Set(negatives.map((e) => e.caseRef)).size;
  const sufficiency = sufficiencyOf(subset.length, posCases, negCases);
  if (!positives.length || !negatives.length) return null;

  const aucOf = (key: ScoreKey): number | null => {
    const meta = SCORE_META.find((m) => m.key === key);
    if (!meta) return null;
    return directionalRoc(
      subset.map((e) => ({ value: value(e, key) as number, positive: isPositive(e) })),
      meta.direction,
    ).auc;
  };
  const coebisAuc = round(aucOf("coebis"), 3);

  // The drug-corrected index on exactly the same rows. An epoch whose case
  // names no agent (or keeps no band powers) carries the raw index unchanged,
  // so the corrected column is never graded on an easier subset than COEBIS.
  const correctedValue = (e: LabelledEpoch): number =>
    value(e, "coebisDrugCorrected") ?? (value(e, "coebis") as number);
  const corrections = subset
    .map((e) => {
      const c = value(e, "coebisDrugCorrected");
      const raw = value(e, "coebis");
      return c == null || raw == null ? 0 : c - raw;
    })
    .filter((d) => d !== 0);
  const correctedAuc = round(
    directionalRoc(
      subset.map((e) => ({ value: correctedValue(e), positive: isPositive(e) })),
      "lower",
    ).auc,
    3,
  );
  const meanCorrection = corrections.length
    ? round(corrections.reduce((a, d) => a + Math.abs(d), 0) / corrections.length, 2)
    : null;
  const correctionDelta =
    correctedAuc != null && coebisAuc != null ? round(correctedAuc - coebisAuc, 3) : null;

  const comparators: ComparatorScore[] = usable
    .map((key) => {
      const auc = round(aucOf(key), 3);
      const oriented = auc == null ? null : round(Math.max(auc, 1 - auc), 3);
      return {
        score: key,
        label: SCORE_META.find((m) => m.key === key)?.label ?? key,
        auc,
        orientedAuc: oriented,
        inverted: auc != null && auc < 0.5,
      };
    })
    .sort((a, b) => (b.orientedAuc ?? 0) - (a.orientedAuc ?? 0));
  // Judge each comparator on its best orientation: an index that runs backwards
  // on this sample still separates the groups, and crediting only its published
  // direction would hand COEBIS a win it did not earn.
  const best = comparators.find((c) => c.orientedAuc != null) ?? null;
  const delta =
    coebisAuc != null && best?.orientedAuc != null
      ? round(coebisAuc - best.orientedAuc, 3)
      : null;

  const correctedVsBest =
    correctedAuc != null && best?.orientedAuc != null
      ? round(correctedAuc - best.orientedAuc, 3)
      : null;

  // What the drug subtraction did, said plainly: it either earns its place on
  // these epochs or it does not, and "no corrected epochs" is a real answer.
  const correctionSentence = (() => {
    if (!corrections.length) {
      return " No recorded agent moved the index on these epochs, so the drug-corrected score is identical to COEBIS here.";
    }
    const moved = `${corrections.length} of ${subset.length} epochs corrected by ${meanCorrection?.toFixed(1) ?? "0.0"} points on average`;
    if (correctedAuc == null || correctionDelta == null) {
      return ` Drug-corrected on ${moved}.`;
    }
    const dir =
      correctionDelta >= 0.02
        ? `improves discrimination to ${correctedAuc.toFixed(2)} (Δ +${correctionDelta.toFixed(2)})`
        : correctionDelta <= -0.02
          ? `costs discrimination, ${correctedAuc.toFixed(2)} (Δ ${correctionDelta.toFixed(2)})`
          : `leaves discrimination unchanged at ${correctedAuc.toFixed(2)}`;
    return ` Subtracting the recorded agents' signatures (${moved}) ${dir}.`;
  })();

  const verdict = (() => {
    if (coebisAuc == null || best?.orientedAuc == null) {
      return "Not enough overlapping epochs to compare COEBIS with the published indices.";
    }
    const qualifier =
      sufficiency === "sufficient"
        ? ""
        : ` Provisional: ${posCases} positive and ${negCases} negative case(s) on the shared subset.`;
    const flipped = best.inverted
      ? ` ${best.label} runs backwards on this sample and is credited at its reversed orientation.`
      : "";
    const head = `On the ${subset.length} epochs where all indices exist, COEBIS AUC ${coebisAuc.toFixed(2)} vs ${best.label} ${best.orientedAuc.toFixed(2)}`;
    const tail = `${flipped}${correctionSentence}${qualifier}`;
    if (delta == null) return `${head}.${tail}`;
    if (delta >= 0.05) return `${head} — COEBIS ahead by ${delta.toFixed(2)}.${tail}`;
    if (delta <= -0.05)
      return `${head} — the published index is ahead by ${Math.abs(delta).toFixed(2)}; COEBIS adds nothing here.${tail}`;
    return `${head} — indistinguishable (Δ ${delta.toFixed(2)}); COEBIS matches the published algorithms rather than beating them.${tail}`;
  })();

  return {
    suppressionOnSubset: subsetSuppression(subset, correctedValue),

    n: subset.length,
    cases: new Set(subset.map((e) => e.caseRef)).size,
    coebisAuc,
    bestComparator: best?.score ?? null,
    bestComparatorLabel: best?.label ?? null,
    bestComparatorAuc: best?.orientedAuc ?? null,
    delta,
    correctedAuc,
    correctedEpochs: corrections.length,
    meanCorrection,
    correctionDelta,
    correctedVsBest,
    comparators,
    sufficiency,
    verdict,
  };
}

function buildAxis(

  key: string,
  label: string,
  description: string,
  positiveLabel: string,
  negativeLabel: string,
  epochs: LabelledEpoch[],
  isPositive: (e: LabelledEpoch) => boolean,
): LabelAxis | null {
  if (!epochs.length) return null;
  const positives = epochs.filter(isPositive);
  const negatives = epochs.filter((e) => !isPositive(e));
  if (!positives.length || !negatives.length) return null;

  const scores = SCORE_META.map((meta) => discriminate(epochs, isPositive, meta)).filter(
    (s): s is ScoreDiscrimination => s !== null,
  );
  const gradeable = scores.filter((s) => s.auc != null && s.sufficiency !== "insufficient");
  const leadScore =
    (gradeable.length
      ? gradeable.reduce((best, s) => (Math.abs((s.auc ?? 0.5) - 0.5) > Math.abs((best.auc ?? 0.5) - 0.5) ? s : best))
      : scores.find((s) => s.auc != null)
    )?.score ?? null;
  const leadMeta = SCORE_META.find((m) => m.key === leadScore) ?? null;

  const posCases = new Set(positives.map((e) => e.caseRef));
  const negCases = new Set(negatives.map((e) => e.caseRef));
  const allCases = new Set(epochs.map((e) => e.caseRef));

  const base: Omit<LabelAxis, "verdict"> = {
    key,
    label,
    positiveLabel,
    negativeLabel,
    description,
    labelSources: [...new Set(epochs.map((e) => e.labelSource))],
    lineages: [...new Set(epochs.map((e) => e.lineage))].sort(),
    n: epochs.length,
    positives: positives.length,
    cases: allCases.size,
    samplePrevalence: round(positives.length / epochs.length, 4),
    casePrevalence: round(posCases.size / allCases.size, 4),
    scores,
    leadScore,
    suppression: suppressionStrata(epochs, isPositive, leadMeta),
    suppressionPositive: round(
      mean(positives.map((e) => e.scores.suppressionRatio).filter((v): v is number => v != null)),
      2,
    ),
    suppressionNegative: round(
      mean(negatives.map((e) => e.scores.suppressionRatio).filter((v): v is number => v != null)),
      2,
    ),
    benchmark: comparatorBenchmark(epochs, isPositive),
    sufficiency: sufficiencyOf(epochs.length, posCases.size, negCases.size),

  };
  return { ...base, verdict: axisVerdict(base) };
}

export function cnsLabelText(level: string): string {
  const map: Record<string, string> = {
    none: "No recorded CNS disease",
    seizure_disorder: "Seizure disorder",
    epilepsy: "Epilepsy",
    stroke: "Stroke",
    hypoxic_brain_injury: "Hypoxic brain injury",
    traumatic_brain_injury: "Traumatic brain injury",
    dementia: "Dementia / cognitive impairment",
    delirium: "Delirium",
    encephalopathy: "Encephalopathy",
  };
  return map[level] ?? level.replace(/_/g, " ");
}

/** Posterior value of a result at an explicitly stated prior. */
export function posteriorAtPrior(
  prior: number,
  sensitivity: number,
  specificity: number,
): { ppv: number | null; npv: number | null; lrPositive: number | null; lrNegative: number | null } {
  const p = Math.min(Math.max(prior, 0), 1);
  const tp = p * sensitivity;
  const fp = (1 - p) * (1 - specificity);
  const tn = (1 - p) * specificity;
  const fn = p * (1 - sensitivity);
  return {
    ppv: tp + fp > 0 ? round(tp / (tp + fp), 4) : null,
    npv: tn + fn > 0 ? round(tn / (tn + fn), 4) : null,
    lrPositive: specificity < 1 ? round(sensitivity / (1 - specificity), 2) : null,
    lrNegative: specificity > 0 ? round((1 - sensitivity) / specificity, 2) : null,
  };
}

/** Full pathology-label evaluation over every labelled epoch supplied. */
export function evaluatePathologyLabels(
  epochs: LabelledEpoch[],
  totalEpochs = epochs.length,
): PathologyLabelEvaluation {
  const byLineage = new Map<string, LabelledEpoch[]>();
  for (const e of epochs) byLineage.set(e.lineage, [...(byLineage.get(e.lineage) ?? []), e]);

  const lineages: LineageInventory[] = [...byLineage.entries()]
    .map(([lineage, rows]) => ({
      lineage,
      epochs: rows.length,
      cases: new Set(rows.map((r) => r.caseRef)).size,
      seizureLabelled: rows.filter((r) => r.seizure != null).length,
      ictal: rows.filter((r) => r.seizure === "ictal").length,
      cnsLabelled: rows.filter((r) => r.cns != null).length,
      suppressionLabelled: rows.filter((r) => r.suppression != null).length,
      suppressed: rows.filter((r) => r.suppression === "suppressed").length,
      stateLabelled: rows.filter((r) => r.state != null).length,

      labelSources: [...new Set(rows.map((r) => r.labelSource))],
      scoresPresent: SCORE_META.filter((m) => rows.some((r) => r.scores[m.key] != null)).map(
        (m) => m.key,
      ),
    }))
    .sort((a, b) => b.epochs - a.epochs);

  const axes: LabelAxis[] = [];

  const seizureRows = epochs.filter((e) => e.seizure != null);
  const seizureAxis = buildAxis(
    "seizure",
    "Recorded seizure activity",
    "Epochs whose ictal status was set by a dataset annotation or a clinician's marked event — never by the app's own detector.",
    "ictal",
    "interictal",
    seizureRows,
    (e) => e.seizure === "ictal",
  );
  if (seizureAxis) axes.push(seizureAxis);

  const cnsRows = epochs.filter((e) => e.cns != null);
  const cnsLevels = [...new Set(cnsRows.map((e) => e.cns!))].filter((l) => l !== "none");
  for (const level of cnsLevels) {
    const rows = cnsRows.filter((e) => e.cns === level || e.cns === "none");
    const axis = buildAxis(
      `cns:${level}`,
      `${cnsLabelText(level)} vs no recorded CNS disease`,
      "Case-level CNS diagnosis taken from the case record or the dataset's participant file.",
      cnsLabelText(level),
      "no recorded CNS disease",
      rows,
      (e) => e.cns === level,
    );
    if (axis) axes.push(axis);
  }

  const suppressionRows = epochs.filter((e) => e.suppression != null);

  const suppressionAxis = buildAxis(
    "recorded-suppression",
    "Recorded burst suppression",
    `Suppression status taken from a bedside monitor's own suppression ratio (≥${MONITOR_SUPPRESSED_PCT}% suppressed, ≤${MONITOR_CLEAR_PCT}% clear; the band between is discarded) or a dataset annotation — never from the app's own suppression calculation.`,
    "suppressed",
    "clear",
    suppressionRows,
    (e) => e.suppression === "suppressed",
  );
  if (suppressionAxis) axes.push(suppressionAxis);

  const stateRows = epochs.filter((e) => e.state === "anaesthetised" || e.state === "awake");
  const stateAxis = buildAxis(
    "recorded-state",
    "Recorded anaesthetised vs awake",
    "Anaesthetic state recorded by the source itself — a dataset event file (loss/return of consciousness markers) or a bedside MOAA/S observation carried on the paired reading. Induction, emergence and intermediate sedation are excluded.",
    "anaesthetised",
    "awake",
    stateRows,
    (e) => e.state === "anaesthetised",
  );
  if (stateAxis) axes.push(stateAxis);

  const notes: string[] = [];
  if (!seizureRows.length) {
    notes.push(
      "No epoch carries an independently recorded ictal label yet, so seizure discrimination cannot be measured. Ingest annotated ictal recordings, or mark seizure events on a live case.",
    );
  } else if (!seizureRows.some((e) => e.seizure === "ictal")) {
    notes.push(
      `${seizureRows.length.toLocaleString()} epochs carry a seizure annotation but all are interictal, so only the false-positive rate is measurable.`,
    );
  }
  if (!suppressionRows.length) {
    notes.push(
      "No epoch carries a monitor- or dataset-recorded suppression label, so the suppression axis grades nothing. Import bedside suppression ratios (e.g. VitalDB BIS SR) to populate it.",
    );
  } else if (!suppressionRows.some((e) => e.suppression === "suppressed")) {
    notes.push(
      `${suppressionRows.length.toLocaleString()} epochs carry a recorded suppression label but none reached ${MONITOR_SUPPRESSED_PCT}% monitor SR, so only the false-positive side is measurable.`,
    );
  } else if (!suppressionRows.some((e) => e.scores.suppressionRatio != null)) {
    notes.push(
      "Recorded suppression labels exist but no app-computed suppression ratio is paired with them, so the axis cannot be graded until those recordings are replayed through the pipeline.",
    );
  }
  if (!stateRows.length) {
    notes.push(
      "No dataset event file has established awake and anaesthetised intervals, so the depth-state axis is empty.",
    );
  }


  if (!cnsLevels.length) {
    notes.push(
      "No case records a CNS diagnosis alongside a control group, so CNS axes are empty. File chronic CNS disease and acute pathology on cases to populate this.",
    );
  }
  if (!epochs.some((e) => e.scores.coebis != null)) {
    notes.push(
      "None of the labelled epochs stores a COEBIS index, so the depth-index rows compare only what was recorded — the surrogate spectral scores.",
    );
  }
  if (axes.every((a) => a.sufficiency !== "sufficient") && axes.length) {
    notes.push(
      `Every axis is below the sufficiency bar of ${MIN_AXIS_EPOCHS} labelled epochs and ${MIN_AXIS_CASES} cases per class. Treat the numbers as orientation only.`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    totalEpochs,
    labelledEpochs: epochs.length,
    lineages,
    axes,
    notes,
  };
}
