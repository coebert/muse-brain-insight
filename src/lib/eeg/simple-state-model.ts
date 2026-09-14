/**
 * Small state models, graded against the big one.
 *
 * The six-descriptor logistic fit has never cleared the promotion bar on the
 * sedation collections, and a model that complex on that much overlap is as
 * likely to be fitting volunteer idiosyncrasies as physiology. The honest test
 * is whether something far smaller — one or two descriptors, bounded weights —
 * separates responsive from unresponsive just as well.
 *
 * Every candidate here is fitted and graded with the same whole-case folds as
 * the full model, on exactly the same epochs, so the comparison is like for
 * like. Nothing here promotes anything: it is a read-out that says how much of
 * the separation a simple rule already gets.
 */

import {
  STATE_FEATURE_NAMES,
  caseFolds,
  separationFromScores,
  type Separation,
  type StateEpoch,
  type StateFeatures,
  type StateModel,
} from "./state-labels";

/** Weight bound, matching the full fit: reshape the index, never invert it. */
const MAX_WEIGHT = 3;
const bound = (v: number) => (v > MAX_WEIGHT ? MAX_WEIGHT : v < -MAX_WEIGHT ? -MAX_WEIGHT : v);

export interface SimpleCandidate {
  key: string;
  label: string;
  /** Indices into {@link STATE_FEATURE_NAMES}. */
  features: number[];
}

const indexOf = (name: keyof StateFeatures) => STATE_FEATURE_NAMES.indexOf(name);

/**
 * The candidates worth trying, smallest first. Each is a descriptor a
 * clinician can already read off a spectrogram, so a win here is explainable
 * at the bedside rather than only in a report.
 */
export const SIMPLE_CANDIDATES: SimpleCandidate[] = [
  { key: "betaDelta", label: "Fast-over-slow power alone", features: [indexOf("logBetaDelta")] },
  { key: "relDelta", label: "Slow-wave share alone", features: [indexOf("relDelta")] },
  { key: "relAlpha", label: "Alpha share alone", features: [indexOf("relAlpha")] },
  { key: "sef", label: "Spectral edge alone", features: [indexOf("sef")] },
  {
    key: "betaDelta+sef",
    label: "Fast-over-slow power and spectral edge",
    features: [indexOf("logBetaDelta"), indexOf("sef")],
  },
  {
    key: "relDelta+relAlpha",
    label: "Slow-wave share and alpha share",
    features: [indexOf("relDelta"), indexOf("relAlpha")],
  },
  {
    key: "betaDelta+suppression",
    label: "Fast-over-slow power and suppression",
    features: [indexOf("logBetaDelta"), indexOf("suppression")],
  },
];

function columnsOf(points: StateEpoch[], features: number[]): number[][] {
  return points.map((p) => {
    const all = STATE_FEATURE_NAMES.map((k) => p.features[k]);
    return features.map((j) => all[j]!);
  });
}

/**
 * A bounded logistic fit over a chosen handful of descriptors. The returned
 * model carries zero weights for every descriptor it does not use, so it can
 * be scored and stored exactly like the full one.
 */
export function fitSimpleModel(points: StateEpoch[], features: number[]): StateModel | null {
  if (points.length < 20 || !features.length) return null;
  const rows = columnsOf(points, features);
  const y = points.map((p) => (p.state === "responsive" ? 1 : 0));
  if (!y.some((v) => v === 1) || !y.some((v) => v === 0)) return null;

  const d = features.length;
  const mu: number[] = [];
  const sd: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = rows.map((r) => r[j]!);
    const m = col.reduce((a, v) => a + v, 0) / col.length;
    const variance = col.reduce((a, v) => a + (v - m) * (v - m), 0) / col.length;
    mu.push(m);
    sd.push(Math.sqrt(variance) || 1);
  }
  const x = rows.map((r) => r.map((v, j) => (v - mu[j]!) / sd[j]!));

  const w = new Array(d + 1).fill(0) as number[];
  const lr = 0.15;
  const l2 = 1e-3;
  for (let iter = 0; iter < 400; iter++) {
    const grad = new Array(d + 1).fill(0) as number[];
    for (let i = 0; i < x.length; i++) {
      let z = w[0]!;
      for (let j = 0; j < d; j++) z += w[j + 1]! * x[i]![j]!;
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i]!;
      grad[0] = grad[0]! + err;
      for (let j = 0; j < d; j++) grad[j + 1] = grad[j + 1]! + err * x[i]![j]!;
    }
    for (let j = 0; j <= d; j++) {
      const g = grad[j]! / x.length + (j === 0 ? 0 : l2 * w[j]!);
      w[j] = j === 0 ? w[j]! - lr * g : bound(w[j]! - lr * g);
    }
  }
  if (w.some((v) => !Number.isFinite(v))) return null;

  // Expand to the full descriptor vector, unused terms weighted zero.
  const full = new Array(STATE_FEATURE_NAMES.length + 1).fill(0) as number[];
  const fullMu = new Array(STATE_FEATURE_NAMES.length).fill(0) as number[];
  const fullSd = new Array(STATE_FEATURE_NAMES.length).fill(1) as number[];
  full[0] = w[0]!;
  features.forEach((j, k) => {
    full[j + 1] = w[k + 1]!;
    fullMu[j] = mu[k]!;
    fullSd[j] = sd[k]!;
  });
  return { w: full, mu: fullMu, sd: fullSd };
}

export interface SimpleModelGrade {
  key: string;
  label: string;
  /** How many descriptors the model reads. */
  terms: number;
  /** Held-out separation, pooled across the whole-case folds. */
  separation: Separation;
  /** Weight on each descriptor it uses, for reading the model aloud. */
  weights: { feature: string; weight: number }[];
}

/** Score every candidate with whole-case holdout on one pool of epochs. */
export function gradeSimpleModels(points: StateEpoch[], maxFolds = 5): SimpleModelGrade[] {
  const folds = caseFolds(points, maxFolds);
  if (folds.length < 2) return [];

  const grades: SimpleModelGrade[] = [];
  for (const candidate of SIMPLE_CANDIDATES) {
    const graded: StateEpoch[] = [];
    const scores: number[] = [];
    for (let i = 0; i < folds.length; i++) {
      const test = folds[i]!;
      const train = folds.filter((_, j) => j !== i).flat();
      const model = fitSimpleModel(train, candidate.features);
      if (!model) continue;
      for (const p of test) {
        graded.push(p);
        scores.push(scoreSimple(model, p.features, candidate.features));
      }
    }
    if (!graded.length) continue;
    const whole = fitSimpleModel(points, candidate.features);
    grades.push({
      key: candidate.key,
      label: candidate.label,
      terms: candidate.features.length,
      separation: separationFromScores(graded, scores),
      weights: candidate.features.map((j) => ({
        feature: STATE_FEATURE_NAMES[j]!,
        weight: Number((whole?.w[j + 1] ?? 0).toFixed(3)),
      })),
    });
  }
  return grades.sort((a, b) => b.separation.auc - a.separation.auc);
}

/** Score one epoch, 0–100, reading only the descriptors the candidate uses. */
export function scoreSimple(
  model: StateModel,
  f: StateFeatures,
  features: number[],
): number {
  const all = STATE_FEATURE_NAMES.map((k) => f[k]);
  let z = model.w[0] ?? 0;
  for (const j of features) {
    const sd = model.sd[j] || 1;
    z += (model.w[j + 1] ?? 0) * ((all[j]! - (model.mu[j] ?? 0)) / sd);
  }
  return 100 / (1 + Math.exp(-z));
}
