/**
 * Putting the COEBIS number where the clinical state actually is.
 *
 * Two separate questions get confused when people say an index is "wrong":
 *
 *  1. Does it *order* states correctly — is a patient who stopped responding
 *     scored below one who is answering? That is discrimination, and nothing
 *     in this file changes it.
 *  2. Does the number land in the band a clinician reads it in — awake in the
 *     eighties, light sedation in the seventies, unconscious in the fifties?
 *     That is calibration, and it is what this file fixes.
 *
 * The tuning here is a *monotone* remapping of the output: a piecewise-linear
 * curve whose segments can never slope downwards. That is a deliberate
 * restriction. A free refit against sedation labels could reorder the index
 * and would quietly overwrite a model fitted on surgical BIS with one fitted
 * on twenty volunteers; a monotone remap cannot invert anything, cannot
 * improve or damage discrimination, and its effect on the existing BIS
 * agreement can be computed exactly and checked before anything is adopted.
 *
 * What the bands mean is a clinical convention, not a measurement:
 * they are where a depth index is conventionally read, and the labels are
 * mapped onto them explicitly below so the assumption is visible.
 */

export type SedationBand = "awake" | "light" | "unconscious";

export interface BandSpec {
  key: SedationBand;
  label: string;
  /** Where a reading in this state should sit. */
  target: number;
  lo: number;
  hi: number;
}

export const SEDATION_BANDS: BandSpec[] = [
  { key: "awake", label: "Awake", target: 90, lo: 80, hi: 100 },
  { key: "light", label: "Light / responsive sedation", target: 70, lo: 60, hi: 80 },
  { key: "unconscious", label: "Unresponsive / anaesthetised", target: 50, lo: 40, hi: 60 },
];

/**
 * Labels to bands. `induction` and `emergence` are transitions, not states,
 * and are excluded from the fit rather than forced into a band; `sedated`
 * without a recorded response is read as light sedation, which is what the
 * collections mean by it.
 */
export function bandOfLabel(label: string): SedationBand | null {
  switch (label) {
    case "awake":
      return "awake";
    case "sedated":
    case "sedated_responsive":
      return "light";
    case "sedated_unresponsive":
    case "anaesthetised":
      return "unconscious";
    default:
      return null; // induction, emergence, seizure, anything unknown
  }
}

/** Deep (below 40) is reserved for burst suppression, which no label here marks. */
export const KNOTS = [0, 20, 40, 50, 60, 70, 80, 100];

export interface SedationTune {
  /** Output value at each entry of {@link KNOTS}; non-decreasing. */
  outputs: number[];
}

export const IDENTITY_TUNE: SedationTune = { outputs: [...KNOTS] };

/** Apply the curve to one index reading. */
export function applyTune(tune: SedationTune, index: number): number {
  const x = Math.min(100, Math.max(0, index));
  for (let i = 1; i < KNOTS.length; i++) {
    const x0 = KNOTS[i - 1]!;
    const x1 = KNOTS[i]!;
    if (x <= x1) {
      const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      const y = tune.outputs[i - 1]! + f * (tune.outputs[i]! - tune.outputs[i - 1]!);
      return Math.min(100, Math.max(0, y));
    }
  }
  return Math.min(100, Math.max(0, tune.outputs[tune.outputs.length - 1]!));
}

export interface BandPoint {
  index: number;
  band: SedationBand;
  caseRef: string;
}

const specOf = (band: SedationBand) => SEDATION_BANDS.find((b) => b.key === band)!;

/**
 * Fit the curve by projected gradient descent.
 *
 * Monotonicity is enforced by parameterising the curve as a base plus
 * non-negative increments, and a pull towards the identity curve keeps the
 * result from contorting itself around a thinly sampled part of the scale.
 */
export function fitSedationTune(points: BandPoint[], pullToIdentity = 0.02): SedationTune | null {
  if (points.length < 100) return null;

  // Each state counts equally, so the largest collection cannot set the scale.
  const weightOf = new Map<SedationBand, number>();
  for (const b of SEDATION_BANDS) {
    const n = points.filter((p) => p.band === b.key).length;
    if (n) weightOf.set(b.key, points.length / (SEDATION_BANDS.length * n));
  }
  if (weightOf.size < 2) return null;

  let base = 0;
  const inc = KNOTS.slice(1).map((k, i) => k - KNOTS[i]!); // identity start
  const lr = 0.15;

  for (let iter = 0; iter < 4000; iter++) {
    const gBase = { v: 0 };
    const gInc = new Array(inc.length).fill(0) as number[];

    const outputs = curveOf(base, inc);
    for (const p of points) {
      const w = weightOf.get(p.band) ?? 0;
      if (!w) continue;
      const err = applyTune({ outputs }, p.index) - specOf(p.band).target;
      // d(output)/d(base) is 1 everywhere; d/d(inc_i) is 1 for every segment
      // fully below the reading, and the partial fraction for the one it is in.
      gBase.v += w * err;
      const x = Math.min(100, Math.max(0, p.index));
      for (let i = 1; i < KNOTS.length; i++) {
        const x0 = KNOTS[i - 1]!;
        const x1 = KNOTS[i]!;
        const share = x >= x1 ? 1 : x <= x0 ? 0 : (x - x0) / (x1 - x0);
        if (share > 0) gInc[i - 1] = gInc[i - 1]! + w * err * share;
      }
    }

    const n = points.length;
    base -= lr * (gBase.v / n);
    for (let i = 0; i < inc.length; i++) {
      const identityInc = KNOTS[i + 1]! - KNOTS[i]!;
      const g = gInc[i]! / n + pullToIdentity * (inc[i]! - identityInc);
      // Segments stay non-negative, so the curve can flatten but never invert.
      inc[i] = Math.max(0, inc[i]! - lr * g);
    }
    if (!Number.isFinite(base) || inc.some((v) => !Number.isFinite(v))) return null;
  }

  return { outputs: curveOf(base, inc) };
}

function curveOf(base: number, inc: number[]): number[] {
  const out = [base];
  for (const d of inc) out.push(out[out.length - 1]! + d);
  return out;
}

export interface BandGrade {
  band: SedationBand;
  label: string;
  epochs: number;
  meanBefore: number;
  meanAfter: number;
  /** Share of epochs landing inside the band's range. */
  inBandBefore: number;
  inBandAfter: number;
}

export function gradeBands(points: BandPoint[], tune: SedationTune): BandGrade[] {
  return SEDATION_BANDS.map((spec) => {
    const xs = points.filter((p) => p.band === spec.key);
    const after = xs.map((p) => applyTune(tune, p.index));
    const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
    const inBand = (v: number[]) =>
      v.length ? v.filter((x) => x >= spec.lo && x <= spec.hi).length / v.length : 0;
    return {
      band: spec.key,
      label: spec.label,
      epochs: xs.length,
      meanBefore: mean(xs.map((p) => p.index)),
      meanAfter: mean(after),
      inBandBefore: inBand(xs.map((p) => p.index)),
      inBandAfter: inBand(after),
    };
  });
}

/** Whole-case folds, so no case is remapped by a curve fitted on itself. */
export function bandFolds(points: BandPoint[], maxFolds = 5): BandPoint[][] {
  const cases = [...new Set(points.map((p) => p.caseRef))].sort();
  const k = Math.min(maxFolds, cases.length);
  if (k < 2) return [];
  const folds: BandPoint[][] = Array.from({ length: k }, () => []);
  const foldOf = new Map<string, number>();
  cases.forEach((c, i) => foldOf.set(c, i % k));
  for (const p of points) folds[foldOf.get(p.caseRef)!]!.push(p);
  return folds.filter((f) => f.length);
}

/** Worth adopting only if band placement clearly improves. */
export const MIN_IN_BAND_GAIN = 0.05;
/** …and the existing BIS agreement must not be spent to buy it. */
export const MAX_BIS_MAE_COST = 1;
