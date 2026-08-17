/**
 * Fit quality of the COEBIS correction currently on screen.
 *
 * COEBIS is refitted from paired commercial-BIS readings, so the number it
 * produces is only as trustworthy as that fit. This turns the stored fit
 * metrics (paired count, residual bias, residual MAE) into a single grade plus
 * a residual summary, and estimates the in-fit percentage — the share of
 * paired readings expected to land within +/-5 BIS units of the monitor.
 *
 * The in-fit figure is an estimate: only summary metrics are stored with each
 * fit, so it assumes a roughly normal residual spread (sigma ~ MAE * 1.2533)
 * around the residual bias. It is labelled as an estimate everywhere it shows.
 */
import type { BisAlignment } from "@/lib/eeg/depth";

/** Agreement band (BIS units) a reading must fall inside to count as in-fit. */
export const COEBIS_IN_FIT_BAND = 5;

/** Paired readings below which a fit is treated as provisional. */
export const COEBIS_MIN_READINGS = 30;

export type CoebisFitGrade = "none" | "provisional" | "fair" | "good";

export interface CoebisFitQuality {
  grade: CoebisFitGrade;
  /** Short badge word, e.g. "Good fit". */
  label: string;
  /** Tone for the badge colour. */
  tone: "default" | "caution" | "critical" | "signal";
  /** Estimated share (0–100) of paired readings within +/-5 units, if known. */
  inFitPercent: number | null;
  /** One-line residual summary, e.g. "bias +1.2 · MAE 3.4 (n = 84)". */
  residualSummary: string;
  /** Longer tooltip explaining what the grade means. */
  detail: string;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 style erf approximation). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Estimated share of residuals inside +/-band, from bias and MAE. */
export function estimateInFitPercent(
  bias: number | null | undefined,
  mae: number | null | undefined,
  band: number = COEBIS_IN_FIT_BAND,
): number | null {
  if (typeof mae !== "number" || !Number.isFinite(mae) || mae < 0) return null;
  const mu = typeof bias === "number" && Number.isFinite(bias) ? bias : 0;
  const sigma = Math.max(mae * 1.2533141373155003, 1e-6);
  const pct = (normalCdf((band - mu) / sigma) - normalCdf((-band - mu) / sigma)) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/**
 * Observed share of residuals inside the band. Preferred over the Gaussian
 * estimate whenever the residuals themselves are available: index residuals sit
 * on a bounded 0–100 scale and pile up near the floor in deep anaesthesia, so
 * they are not normally distributed and the analytic figure can disagree with
 * what actually happened.
 */
export function empiricalInFitPercent(
  residuals: number[],
  band: number = COEBIS_IN_FIT_BAND,
): number | null {
  const usable = residuals.filter((r) => Number.isFinite(r));
  if (usable.length < 5) return null;
  const inside = usable.filter((r) => Math.abs(r) <= band).length;
  return Math.round((inside / usable.length) * 100);
}

export function computeCoebisFitQuality(
  model: BisAlignment | null,
  /** Observed residuals (prediction − monitor) when they are to hand. */
  residuals?: number[],
): CoebisFitQuality {
  if (!model) {
    return {
      grade: "none",
      label: "No fit yet",
      tone: "critical",
      inFitPercent: null,
      residualSummary: "No paired commercial BIS readings yet",
      detail:
        "COEBIS has no fitted correction yet. Enter paired commercial BIS readings during cases to build one.",
    };
  }

  const bias = typeof model.biasAfter === "number" ? model.biasAfter : null;
  const mae = typeof model.maeAfter === "number" ? model.maeAfter : null;
  const observed = residuals ? empiricalInFitPercent(residuals) : null;
  const inFitPercent = observed ?? estimateInFitPercent(bias, mae);
  const inFitObserved = observed != null;

  const parts: string[] = [];
  parts.push(bias == null ? "bias —" : `bias ${bias >= 0 ? "+" : ""}${bias.toFixed(1)}`);
  parts.push(mae == null ? "MAE —" : `MAE ${mae.toFixed(1)}`);
  parts.push(`n = ${model.n}`);
  const residualSummary = parts.join(" · ");

  let grade: CoebisFitGrade;
  if (model.n < COEBIS_MIN_READINGS || mae == null) grade = "provisional";
  else if (mae <= 4 && Math.abs(bias ?? 0) <= 2) grade = "good";
  else if (mae <= 7 && Math.abs(bias ?? 0) <= 4) grade = "fair";
  else grade = "provisional";

  const label =
    grade === "good" ? "Good fit" : grade === "fair" ? "Fair fit" : "Provisional fit";
  const tone = grade === "good" ? "signal" : grade === "fair" ? "caution" : "critical";

  const inFitText =
    inFitPercent == null
      ? "In-fit share not estimable yet."
      : inFitObserved
        ? `${inFitPercent}% of paired readings actually landed within ±${COEBIS_IN_FIT_BAND} BIS units of the monitor.`
        : `About ${inFitPercent}% of paired readings are expected within ±${COEBIS_IN_FIT_BAND} BIS units of the monitor (estimated from the residual spread — the observed share is shown once the residuals are loaded).`;

  const gradeText =
    grade === "good"
      ? "Residuals are small and near-unbiased — treat COEBIS as a usable estimate of the commercial number."
      : grade === "fair"
        ? "Residuals are moderate — COEBIS tracks the monitor but individual readings can differ by several units."
        : model.n < COEBIS_MIN_READINGS
          ? `Fitted on only ${model.n} paired readings (below ${COEBIS_MIN_READINGS}) — interpret COEBIS with caution.`
          : "Residuals are large — interpret COEBIS with caution and keep entering paired readings.";

  return {
    grade,
    label,
    tone,
    inFitPercent,
    residualSummary,
    detail: `${gradeText} ${inFitText} Residuals: ${residualSummary}.`,
  };
}
