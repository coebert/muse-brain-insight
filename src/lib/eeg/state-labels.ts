/**
 * Conscious / unconscious state labels as a COEBIS training target.
 *
 * The PhysioNet `eeg-power-anesthesia` collection publishes a state word per
 * epoch ("awake", "unconscious", …), not a monitor number. Turning a word into
 * an invented depth score would teach the index a value nobody measured, so
 * those labels are used for what they genuinely are: a **separation target**.
 * A depth index should read high while the patient is responsive and low while
 * they are not, and how cleanly it does that is measurable.
 *
 * Everything here is graded with whole-case holdout — a case never appears in
 * both the fit and the grade — and the fitted model stays inside its own
 * lineage. It never enters device-specific paired alignment.
 */

export const STATE_LINEAGE_KEY = "external:physionet:eeg-power-anesthesia:state";
export const STATE_MODEL_FAMILY = "state-separation";

/** Published labels that mean the patient was responsive. */
const RESPONSIVE = new Set(["awake", "emergence"]);
/** Published labels that mean the patient was not responsive. */
const UNRESPONSIVE = new Set(["anaesthetised", "burst_suppression", "isoelectric"]);

export type ResponseState = "responsive" | "unresponsive";

/**
 * Collapse a stored label to responsive / unresponsive.
 *
 * `sedated` is deliberately dropped: it spans patients who answer and patients
 * who do not, so scoring it either way would blur the very boundary this fit
 * exists to sharpen.
 */
export function collapseState(label: string | null | undefined): ResponseState | null {
  if (!label) return null;
  const v = label.trim().toLowerCase();
  if (RESPONSIVE.has(v)) return "responsive";
  if (UNRESPONSIVE.has(v)) return "unresponsive";
  return null;
}

export interface StateBands {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

/** Interpretable descriptors rebuilt from one stored spectral epoch. */
export interface StateFeatures {
  /** log10 of fast-over-slow power — the classic depth discriminator. */
  logBetaDelta: number;
  relDelta: number;
  relAlpha: number;
  relBeta: number;
  /** Spectral edge, scaled onto 0–1 over the stored 0–30 Hz grid. */
  sef: number;
  /** Suppression ratio, 0–1. */
  suppression: number;
}

export const STATE_FEATURE_NAMES: (keyof StateFeatures)[] = [
  "logBetaDelta",
  "relDelta",
  "relAlpha",
  "relBeta",
  "sef",
  "suppression",
];

export interface StateEpoch {
  caseRef: string;
  atSeconds: number;
  label: string;
  state: ResponseState;
  features: StateFeatures;
}

const EPS = 1e-6;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function featuresFrom(
  bands: StateBands,
  sef95: number | null,
  suppressionRatio: number | null,
): StateFeatures {
  const total =
    Math.max(bands.delta, 0) +
    Math.max(bands.theta, 0) +
    Math.max(bands.alpha, 0) +
    Math.max(bands.beta, 0) +
    Math.max(bands.gamma, 0) +
    EPS;
  const fast = Math.max(bands.beta, 0) + Math.max(bands.gamma, 0) + EPS;
  const slow = Math.max(bands.delta, 0) + EPS;
  return {
    logBetaDelta: Math.log10(fast / slow),
    relDelta: clamp01(Math.max(bands.delta, 0) / total),
    relAlpha: clamp01(Math.max(bands.alpha, 0) / total),
    relBeta: clamp01(Math.max(bands.beta, 0) / total),
    sef: clamp01((sef95 ?? 0) / 30),
    suppression: clamp01((suppressionRatio ?? 0) / 100),
  };
}

export interface StateModel {
  /** Intercept, then one weight per {@link STATE_FEATURE_NAMES} entry. */
  w: number[];
  /** Feature means and standard deviations used to standardise inputs. */
  mu: number[];
  sd: number[];
}

/**
 * The reference mapping this pool is graded against: a documented default,
 * not a fit. Fast-over-slow power and spectral edge push the index up;
 * slow-wave dominance and suppression push it down.
 */
export const BASELINE_STATE_MODEL: StateModel = {
  w: [0, 1.8, -2.2, -0.4, 0.6, 2.0, -3.0],
  mu: [0, 0, 0, 0, 0, 0],
  sd: [1, 1, 1, 1, 1, 1],
};

function vectorOf(f: StateFeatures): number[] {
  return STATE_FEATURE_NAMES.map((k) => f[k]);
}

function logit(model: StateModel, f: StateFeatures): number {
  const x = vectorOf(f);
  let z = model.w[0] ?? 0;
  for (let i = 0; i < x.length; i++) {
    const sd = model.sd[i] || 1;
    z += (model.w[i + 1] ?? 0) * ((x[i]! - (model.mu[i] ?? 0)) / sd);
  }
  return z;
}

/** Score one epoch on the familiar 0–100 scale; higher means more awake. */
export function scoreState(model: StateModel, f: StateFeatures): number {
  const z = logit(model, f);
  return 100 / (1 + Math.exp(-z));
}

/* ------------------------------------------------------------- grading --- */

export interface CutPoint {
  index: number;
  sensitivity: number;
  specificity: number;
}

export interface Separation {
  epochs: number;
  cases: number;
  responsive: number;
  unresponsive: number;
  /** Probability a random responsive epoch scores above a random unresponsive one. */
  auc: number;
  meanResponsive: number;
  meanUnresponsive: number;
  /** Gap between the two state averages, in index points. */
  gap: number;
  /** Share of epochs on the wrong side of the best cut-point. */
  overlap: number;
  cut: CutPoint | null;
}

export const EMPTY_SEPARATION: Separation = {
  epochs: 0,
  cases: 0,
  responsive: 0,
  unresponsive: 0,
  auc: 0.5,
  meanResponsive: 0,
  meanUnresponsive: 0,
  gap: 0,
  overlap: 1,
  cut: null,
};

interface Scored {
  score: number;
  state: ResponseState;
}

function auc(scored: Scored[]): number {
  const pos = scored.filter((s) => s.state === "responsive");
  const neg = scored.filter((s) => s.state === "unresponsive");
  if (!pos.length || !neg.length) return 0.5;
  // Rank-based Mann–Whitney statistic, ties counted as half.
  const sorted = [...scored].sort((a, b) => a.score - b.score);
  const ranks = new Map<number, number>();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.score === sorted[i]!.score) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks.set(k, rank);
    i = j + 1;
  }
  let rankSum = 0;
  sorted.forEach((s, idx) => {
    if (s.state === "responsive") rankSum += ranks.get(idx)!;
  });
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

function bestCut(scored: Scored[]): CutPoint | null {
  const pos = scored.filter((s) => s.state === "responsive").length;
  const neg = scored.length - pos;
  if (!pos || !neg) return null;
  let best: CutPoint | null = null;
  for (let cut = 5; cut <= 95; cut += 1) {
    const tp = scored.filter((s) => s.state === "responsive" && s.score >= cut).length;
    const tn = scored.filter((s) => s.state === "unresponsive" && s.score < cut).length;
    const sensitivity = tp / pos;
    const specificity = tn / neg;
    if (!best || sensitivity + specificity > best.sensitivity + best.specificity) {
      best = { index: cut, sensitivity, specificity };
    }
  }
  return best;
}

export function separationOf(
  points: StateEpoch[],
  score: (f: StateFeatures) => number,
): Separation {
  if (!points.length) return EMPTY_SEPARATION;
  const scored: Scored[] = points.map((p) => ({ score: score(p.features), state: p.state }));
  const pos = scored.filter((s) => s.state === "responsive");
  const neg = scored.filter((s) => s.state === "unresponsive");
  const mean = (xs: Scored[]) =>
    xs.length ? xs.reduce((a, s) => a + s.score, 0) / xs.length : 0;
  const cut = bestCut(scored);
  const wrong = cut
    ? scored.filter((s) =>
        s.state === "responsive" ? s.score < cut.index : s.score >= cut.index,
      ).length
    : scored.length;
  const meanResponsive = mean(pos);
  const meanUnresponsive = mean(neg);
  return {
    epochs: points.length,
    cases: new Set(points.map((p) => p.caseRef)).size,
    responsive: pos.length,
    unresponsive: neg.length,
    auc: auc(scored),
    meanResponsive,
    meanUnresponsive,
    gap: meanResponsive - meanUnresponsive,
    overlap: scored.length ? wrong / scored.length : 1,
    cut,
  };
}

/* ----------------------------------------------------------------- fit --- */

/** Below this the pool is too small for a case-held-out grade to mean anything. */
export const MIN_EPOCHS = 200;
export const MIN_CASES = 4;
export const MIN_PER_STATE = 50;
/** Held-out separation must beat the reference by at least this much. */
export const MIN_AUC_GAIN = 0.02;
/** …and must itself be usable, not merely better than a poor reference. */
export const MIN_AUC = 0.7;
/** Weights are bounded, so the fit can reshape the index but never invert it. */
export const MAX_WEIGHT = 3;

const bound = (v: number) => (v > MAX_WEIGHT ? MAX_WEIGHT : v < -MAX_WEIGHT ? -MAX_WEIGHT : v);

/** Bounded logistic fit over the standardised descriptors. */
export function fitStateModel(points: StateEpoch[]): StateModel | null {
  if (points.length < 20) return null;
  const rows = points.map((p) => vectorOf(p.features));
  const y = points.map((p) => (p.state === "responsive" ? 1 : 0));
  if (!y.some((v) => v === 1) || !y.some((v) => v === 0)) return null;

  const d = STATE_FEATURE_NAMES.length;
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
  return { w, mu, sd };
}

export interface StateFitReport {
  epochs: number;
  cases: number;
  responsive: number;
  unresponsive: number;
  folds: number;
  /** Held-out separation of the reference mapping. */
  before: Separation;
  /** Held-out separation of the candidate, pooled across folds. */
  after: Separation;
  aucGain: number;
  /** Candidate refitted on every case, stored only when it is promoted. */
  model: StateModel | null;
  promote: boolean;
  reason: string;
  digest: string;
}

function digestOf(points: StateEpoch[]): string {
  const cases = [...new Set(points.map((p) => p.caseRef))].sort();
  return `${points.length}:${cases.length}:${cases.slice(0, 8).join(",")}`;
}

/** Whole-case folds, so no case is scored by a model that saw it. */
export function caseFolds(points: StateEpoch[], maxFolds = 5): StateEpoch[][] {
  const cases = [...new Set(points.map((p) => p.caseRef))].sort();
  const k = Math.min(maxFolds, cases.length);
  if (k < 2) return [];
  const folds: StateEpoch[][] = Array.from({ length: k }, () => []);
  const foldOf = new Map<string, number>();
  cases.forEach((c, i) => foldOf.set(c, i % k));
  for (const p of points) folds[foldOf.get(p.caseRef)!]!.push(p);
  return folds.filter((f) => f.length);
}

export function gradeStateFit(points: StateEpoch[]): StateFitReport {
  const cases = new Set(points.map((p) => p.caseRef)).size;
  const responsive = points.filter((p) => p.state === "responsive").length;
  const unresponsive = points.length - responsive;
  const base: StateFitReport = {
    epochs: points.length,
    cases,
    responsive,
    unresponsive,
    folds: 0,
    before: EMPTY_SEPARATION,
    after: EMPTY_SEPARATION,
    aucGain: 0,
    model: null,
    promote: false,
    reason: "",
    digest: digestOf(points),
  };

  if (points.length < MIN_EPOCHS) {
    return { ...base, reason: `Only ${points.length} labelled epochs; ${MIN_EPOCHS} needed.` };
  }
  if (cases < MIN_CASES) {
    return { ...base, reason: `Only ${cases} labelled cases; ${MIN_CASES} needed.` };
  }
  if (responsive < MIN_PER_STATE || unresponsive < MIN_PER_STATE) {
    return {
      ...base,
      reason: `Needs ${MIN_PER_STATE} epochs of each state (has ${responsive} responsive, ${unresponsive} unresponsive).`,
    };
  }

  const folds = caseFolds(points);
  if (folds.length < 2) return { ...base, reason: "Not enough separate cases to hold any out." };

  const heldOut: { point: StateEpoch; score: number }[] = [];
  for (let i = 0; i < folds.length; i++) {
    const test = folds[i]!;
    const train = folds.filter((_, j) => j !== i).flat();
    const model = fitStateModel(train);
    if (!model) continue;
    for (const p of test) heldOut.push({ point: p, score: scoreState(model, p.features) });
  }
  if (!heldOut.length) return { ...base, reason: "No fold produced a usable fit." };

  const scores = new Map(heldOut.map((h) => [h.point, h.score]));
  const graded = heldOut.map((h) => h.point);
  const after = separationOf(graded, (f) => {
    const hit = graded.find((p) => p.features === f);
    return hit ? (scores.get(hit) ?? 50) : 50;
  });
  const before = separationOf(graded, (f) => scoreState(BASELINE_STATE_MODEL, f));
  const aucGain = after.auc - before.auc;

  const promote = aucGain >= MIN_AUC_GAIN && after.auc >= MIN_AUC;
  const reason = promote
    ? `Held-out separation improved from ${before.auc.toFixed(3)} to ${after.auc.toFixed(3)}.`
    : after.auc < MIN_AUC
      ? `Held-out separation ${after.auc.toFixed(3)} is below the ${MIN_AUC} bar.`
      : `Held-out separation gained only ${aucGain.toFixed(3)}; ${MIN_AUC_GAIN} needed.`;

  return {
    ...base,
    folds: folds.length,
    before,
    after,
    aucGain,
    model: promote ? fitStateModel(points) : null,
    promote,
    reason,
  };
}
