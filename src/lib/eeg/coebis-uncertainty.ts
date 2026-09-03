/**
 * Prediction uncertainty for COEBIS.
 *
 * A single COEBIS number invites more confidence than the evidence behind it
 * usually supports: the fit came from a finite set of paired readings, the
 * patient's covariates may be unknown, and the second on screen may be noisy,
 * suppressed or unreliable. This module turns those into an honest interval
 * around each prediction, and — separately — scores how well those intervals
 * actually behaved against real commercial BIS readings.
 *
 * Nothing here changes the point estimate. The interval is a statement about
 * how much room the model needs, not a correction to what it said.
 */

import type { BisAlignment } from "./depth";

/** Standard-deviation-to-MAE factor for a normal error distribution. */
const MAE_TO_SIGMA = 1.2533;

/** Spread assumed when a model reports no held-out error of its own. */
const DEFAULT_MODEL_SIGMA = 9;
/** Spread assumed with no fitted model at all (raw index vs monitor). */
const UNFITTED_SIGMA = 14;
/** Extra spread when the patient terms could not be applied. */
const UNKNOWN_COVARIATE_SIGMA = 3;
/** Ceiling so an interval never becomes a meaningless 0–100 band. */
const MAX_SIGMA = 25;

/** Nominal levels the calibration report scores. */
export const CALIBRATION_LEVELS = [0.5, 0.9] as const;

/** Two-sided normal quantile for the levels we support. */
export function zForLevel(level: number): number {
  const table: [number, number][] = [
    [0.5, 0.6745],
    [0.68, 0.9945],
    [0.8, 1.2816],
    [0.9, 1.6449],
    [0.95, 1.96],
    [0.99, 2.5758],
  ];
  let best = table[0]!;
  for (const row of table) {
    if (Math.abs(row[0] - level) < Math.abs(best[0] - level)) best = row;
  }
  return best[1];
}

export interface UncertaintyInputs {
  /** The COEBIS value the interval is drawn around. */
  prediction: number | null;
  /** Whether the second was analysed from a usable signal. */
  reliable?: boolean;
  /** Signal quality 0–1, when the source reports it. */
  sqi?: number | null;
  /** Trailing suppression ratio, %. */
  suppressionRatio?: number | null;
  /** SD of the raw index over the surrounding seconds, when known. */
  volatility?: number | null;
  /** False when the case covariates the model wants are missing. */
  covariatesKnown?: boolean;
}

export interface PredictionInterval {
  prediction: number;
  sigma: number;
  lower: number;
  upper: number;
  level: number;
  /** Plain-language reasons the band is as wide as it is, largest first. */
  drivers: string[];
}

/** Spread contributed by the model itself, before anything about this second. */
export function modelSigma(model: BisAlignment | null | undefined): number {
  if (!model) return UNFITTED_SIGMA;
  const fromMae =
    model.maeAfter != null && Number.isFinite(model.maeAfter) && model.maeAfter > 0
      ? model.maeAfter * MAE_TO_SIGMA
      : DEFAULT_MODEL_SIGMA;
  // Finite training data: the fitted map itself is uncertain, and provisional
  // fits sit below the full 30-reading / 3-case bar.
  const n = Math.max(1, model.n || 1);
  const smallSample = Math.sqrt(1 + 1 / n);
  const provisional = model.provisional ? 1.35 : 1;
  return Math.min(MAX_SIGMA, fromMae * smallSample * provisional);
}

/**
 * The interval for one prediction. Contributions are combined in quadrature:
 * they are separate sources of error, not a worst case stacked end to end.
 */
export function predictionInterval(
  input: UncertaintyInputs,
  model: BisAlignment | null | undefined,
  level = 0.9,
): PredictionInterval | null {
  if (input.prediction == null || !Number.isFinite(input.prediction)) return null;

  const parts: { sigma: number; why: string }[] = [
    {
      sigma: modelSigma(model),
      why: model
        ? model.provisional
          ? `provisional fit on ${model.n} paired readings`
          : `model spread from ${model.n} paired readings`
        : "no fitted model — raw index against the monitor",
    },
  ];

  if (model && input.covariatesKnown === false && (model.terms?.length ?? 0) > 0) {
    parts.push({ sigma: UNKNOWN_COVARIATE_SIGMA, why: "patient covariates unknown" });
  }
  if (input.reliable === false) {
    parts.push({ sigma: 8, why: "second flagged unreliable" });
  }
  const sqi = input.sqi;
  if (sqi != null && Number.isFinite(sqi) && sqi < 0.6) {
    parts.push({ sigma: (0.6 - Math.max(0, sqi)) * 15, why: "poor signal quality" });
  }
  const sr = input.suppressionRatio ?? 0;
  if (sr > 0) {
    // Monitors and open indices diverge most across burst suppression.
    parts.push({ sigma: Math.min(6, sr * 0.08), why: `burst suppression ${Math.round(sr)}%` });
  }
  const vol = input.volatility;
  if (vol != null && Number.isFinite(vol) && vol > 0) {
    parts.push({ sigma: Math.min(8, vol * 0.8), why: "index moving quickly" });
  }

  const sigma = Math.min(
    MAX_SIGMA,
    Math.sqrt(parts.reduce((sum, p) => sum + p.sigma * p.sigma, 0)),
  );
  const z = zForLevel(level);
  const half = z * sigma;
  return {
    prediction: input.prediction,
    sigma,
    lower: Math.max(0, input.prediction - half),
    upper: Math.min(100, input.prediction + half),
    level,
    drivers: parts
      .filter((p) => p.sigma >= 0.5)
      .sort((a, b) => b.sigma - a.sigma)
      .map((p) => p.why),
  };
}

export interface CalibrationSample {
  prediction: number;
  sigma: number;
  actual: number;
}

export interface CoverageAtLevel {
  nominal: number;
  empirical: number;
  n: number;
  /** Mean full width of the interval at this level, index points. */
  meanWidth: number;
}

export interface CalibrationReport {
  n: number;
  levels: CoverageAtLevel[];
  /**
   * SD of the standardised errors (actual − prediction) / sigma. 1 means the
   * quoted spread matches reality; >1 means the intervals are too narrow.
   */
  zSpread: number;
  /** Mean standardised error — a systematic offset the interval hides. */
  zBias: number;
  verdict: "well-calibrated" | "overconfident" | "conservative" | "insufficient";
  summary: string;
}

/**
 * How the quoted intervals actually behaved. Coverage is measured directly
 * against real monitor readings, so a band that looks reassuring but rarely
 * contains the truth is reported as overconfident rather than left to stand.
 */
export function calibrationReport(
  samples: CalibrationSample[],
  levels: readonly number[] = CALIBRATION_LEVELS,
): CalibrationReport {
  const usable = samples.filter(
    (s) =>
      Number.isFinite(s.prediction) &&
      Number.isFinite(s.actual) &&
      Number.isFinite(s.sigma) &&
      s.sigma > 0,
  );
  if (usable.length < 10) {
    return {
      n: usable.length,
      levels: [],
      zSpread: Number.NaN,
      zBias: Number.NaN,
      verdict: "insufficient",
      summary: `Only ${usable.length} paired readings — at least 10 are needed before interval coverage means anything.`,
    };
  }

  const z = usable.map((s) => (s.actual - s.prediction) / s.sigma);
  const zBias = z.reduce((a, b) => a + b, 0) / z.length;
  const zSpread = Math.sqrt(z.reduce((a, b) => a + b * b, 0) / z.length);

  const coverage: CoverageAtLevel[] = levels.map((nominal) => {
    const zc = zForLevel(nominal);
    let hits = 0;
    let width = 0;
    for (const s of usable) {
      const lo = Math.max(0, s.prediction - zc * s.sigma);
      const hi = Math.min(100, s.prediction + zc * s.sigma);
      if (s.actual >= lo && s.actual <= hi) hits += 1;
      width += hi - lo;
    }
    return {
      nominal,
      empirical: hits / usable.length,
      n: usable.length,
      meanWidth: width / usable.length,
    };
  });

  const headline = coverage.find((c) => c.nominal === 0.9) ?? coverage[coverage.length - 1]!;
  const gap = headline.empirical - headline.nominal;
  const verdict: CalibrationReport["verdict"] =
    gap < -0.07 ? "overconfident" : gap > 0.07 ? "conservative" : "well-calibrated";

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const summary =
    verdict === "overconfident"
      ? `Intervals are too narrow: the monitor fell inside the ${pct(headline.nominal)} band only ${pct(headline.empirical)} of the time (${usable.length} readings). Treat COEBIS as less certain than the band suggests.`
      : verdict === "conservative"
        ? `Intervals are wider than they need to be: ${pct(headline.empirical)} coverage against a ${pct(headline.nominal)} target over ${usable.length} readings.`
        : `Intervals hold up: ${pct(headline.empirical)} of ${usable.length} monitor readings fell inside the ${pct(headline.nominal)} band.`;

  return { n: usable.length, levels: coverage, zSpread, zBias, verdict, summary };
}

/** Rolling SD of a numeric series, used as the volatility term. */
export function localVolatility(
  values: (number | null)[],
  centre: number,
  half = 5,
): number | null {
  const window: number[] = [];
  for (let i = Math.max(0, centre - half); i <= Math.min(values.length - 1, centre + half); i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) window.push(v);
  }
  if (window.length < 3) return null;
  const m = window.reduce((a, b) => a + b, 0) / window.length;
  return Math.sqrt(window.reduce((a, b) => a + (b - m) ** 2, 0) / (window.length - 1));
}
