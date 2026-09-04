/**
 * Ketamine recognition for COEBIS.
 *
 * Every processed depth index in clinical use — BIS, Entropy, PSI, and the
 * published OpenIBIS algorithm this app re-implements — was derived on GABAergic
 * anaesthesia (propofol, volatiles). Ketamine is an NMDA antagonist and does the
 * opposite to the frontal EEG: it augments beta (13–30 Hz) and gamma (30–47 Hz)
 * power and attenuates or abolishes the frontal alpha spindle, while slow-delta
 * activity persists or increases at anaesthetic doses. Because the ratio-based
 * indices read high-frequency power as arousal, the displayed number rises even
 * though the patient is not lighter — the well-documented "spuriously high BIS
 * after ketamine".
 *
 * This module does two things, and deliberately not a third:
 *
 *  1. It measures the EEG pattern (beta+gamma share, alpha spindle, slow-wave
 *     share) that ketamine produces.
 *  2. When ketamine exposure is *declared* for the case, it applies a bounded
 *     downward correction to COEBIS so the beta/gamma augmentation is not
 *     reported as a lighter patient.
 *  3. It does NOT infer ketamine from the EEG alone. A frontal beta/gamma
 *     pattern is also produced by frontal EMG, arousal, and light anaesthesia
 *     itself, so an undeclared pattern raises an advisory only — it never moves
 *     the number. Nor does the correction ever manufacture depth: it is capped,
 *     it is floored so it cannot drive the index into the "deep" range on its
 *     own, and it is never applied to the raw OpenIBIS index or to paired
 *     readings used to fit COEBIS.
 */

/** Largest movement this stage can make, in index points. */
export const KETAMINE_CAP = 12;
/**
 * The correction cannot pull the index below this on its own. Ketamine keeps
 * the EEG activated at clinically adequate depth, so reporting a deep number
 * would be as misleading as reporting a light one.
 */
export const KETAMINE_FLOOR = 40;
/** Beta+gamma share above which the spectrum is atypical for GABAergic GA. */
export const BETA_GAMMA_BASELINE = 0.15;
/** Beta+gamma share at which the ketamine pattern is regarded as full-strength. */
export const BETA_GAMMA_FULL = 0.3;

/** Spectral shares used by the detector, all fractions of 0.5–47 Hz power. */
export interface KetamineFeatures {
  /** 13–30 Hz share. */
  betaFraction: number | null;
  /** 30–47 Hz share. */
  gammaFraction: number | null;
  /** 8–12 Hz share — the propofol alpha spindle ketamine suppresses. */
  alphaFraction: number | null;
  /** 0.5–4 Hz share. */
  slowFraction: number | null;
}

export const EMPTY_KETAMINE_FEATURES: KetamineFeatures = {
  betaFraction: null,
  gammaFraction: null,
  alphaFraction: null,
  slowFraction: null,
};

/** How the app knows ketamine is on board. */
export type KetamineExposure = "declared" | "none";

export interface KetamineSignature {
  /** Combined 13–47 Hz share, or null when the spectrum is unavailable. */
  betaGamma: number | null;
  /** 0–1 strength of the ketamine-like spectral pattern. */
  score: number;
  /** Exposure as declared by the case record / drug entry. */
  exposure: KetamineExposure;
  /** Ketamine declared AND the pattern present — the correction is live. */
  corrected: boolean;
  /** Pattern present but ketamine not declared — advisory only. */
  advisory: boolean;
  /** Index points removed by this stage (<= 0). */
  delta: number;
  /** Plain-language evidence lines. */
  reasons: string[];
}

export const NO_KETAMINE: KetamineSignature = {
  betaGamma: null,
  score: 0,
  exposure: "none",
  corrected: false,
  advisory: false,
  delta: 0,
  reasons: [],
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** True when the regimen / drug entry records ketamine for this case. */
export function ketamineDeclared(input: {
  regimen?: string | null;
  ketamineCe?: number | null;
  markers?: string[] | null;
}): boolean {
  if (input.regimen && /ketamine/i.test(input.regimen)) return true;
  if (input.ketamineCe != null && Number.isFinite(input.ketamineCe) && input.ketamineCe > 0) {
    return true;
  }
  return (input.markers ?? []).some((m) => /ketamine/i.test(m));
}

/**
 * Strength of the ketamine spectral pattern, 0–1.
 *
 * Three ingredients, all required to some degree:
 *  - beta+gamma share above what GABAergic anaesthesia produces,
 *  - an absent or attenuated frontal alpha spindle,
 *  - preserved slow-wave activity, which distinguishes an activated
 *    anaesthetised EEG from a genuinely awake one.
 */
export function ketamineScore(f: KetamineFeatures): { score: number; betaGamma: number | null } {
  const beta = f.betaFraction;
  const gamma = f.gammaFraction;
  if (beta == null || gamma == null || !Number.isFinite(beta) || !Number.isFinite(gamma)) {
    return { score: 0, betaGamma: null };
  }
  const betaGamma = clamp(beta + gamma, 0, 1);
  const fast = clamp(
    (betaGamma - BETA_GAMMA_BASELINE) / (BETA_GAMMA_FULL - BETA_GAMMA_BASELINE),
    0,
    1,
  );
  if (fast <= 0) return { score: 0, betaGamma };

  // Alpha spindle: full weight when it is gone, 0.6 when it is still present
  // (mixed propofol/ketamine still shows some spindle activity).
  const alpha = f.alphaFraction;
  const alphaWeight = alpha == null ? 0.8 : alpha < 0.12 ? 1 : clamp(1 - (alpha - 0.12) * 4, 0.5, 1);

  // Slow-wave evidence: without it, fast activity is more likely a genuinely
  // light or awake patient, and correcting downward would be unsafe.
  const slow = f.slowFraction;
  const slowWeight = slow == null ? 0.5 : clamp((slow - 0.2) / 0.2, 0, 1);

  return { score: clamp(fast * alphaWeight * slowWeight, 0, 1), betaGamma };
}

export interface KetamineInputs {
  /** COEBIS value after the pooled, knot, covariate and adjunct stages. */
  aligned: number | null;
  features: KetamineFeatures;
  exposure: KetamineExposure;
  /** Suppression ratio, 0–100 %. */
  bsr: number;
  /** 0–1 signal-quality score; a poor signal shrinks the correction. */
  quality?: number | null;
}

/**
 * Evaluate the ketamine stage: the pattern, whether it is acted on, and the
 * bounded correction it produces.
 */
export function ketamineCorrection({
  aligned,
  features,
  exposure,
  bsr,
  quality,
}: KetamineInputs): KetamineSignature {
  const { score, betaGamma } = ketamineScore(features);
  const reasons: string[] = [];
  const safeBsr = clamp(Number.isFinite(bsr) ? bsr : 0, 0, 100);

  if (betaGamma != null && score > 0) {
    reasons.push(
      `Fast-frequency (13–47 Hz) power is ${(betaGamma * 100).toFixed(0)} % of the spectrum, well above the ${(BETA_GAMMA_BASELINE * 100).toFixed(0)} % typical of propofol or volatile anaesthesia.`,
    );
    if (features.alphaFraction != null && features.alphaFraction < 0.12) {
      reasons.push(
        `The frontal alpha spindle is attenuated (${(features.alphaFraction * 100).toFixed(0)} % of power), which is what ketamine does to the propofol pattern.`,
      );
    }
    if (features.slowFraction != null && features.slowFraction >= 0.3) {
      reasons.push(
        `Slow-wave activity is preserved (${(features.slowFraction * 100).toFixed(0)} % of power), so the fast activity is an activated anaesthetised EEG rather than an awake one.`,
      );
    }
  }

  if (exposure !== "declared") {
    const advisory = score >= 0.4;
    if (advisory) {
      reasons.push(
        "Ketamine is not recorded for this case. If it has been given, the index is reading high; record it so COEBIS can correct for it. No correction has been applied on the EEG pattern alone.",
      );
    }
    return { betaGamma, score, exposure, corrected: false, advisory, delta: 0, reasons };
  }

  // Declared ketamine. Suppression governs the number in its own right, and
  // there is nothing to correct if the index is already reporting depth.
  if (score <= 0 || safeBsr >= 20 || aligned == null || aligned <= KETAMINE_FLOOR) {
    if (score <= 0 && betaGamma != null) {
      reasons.push(
        "Ketamine is recorded, but the spectrum does not currently show the beta/gamma augmentation it produces, so no correction is applied.",
      );
    }
    return { betaGamma, score, exposure, corrected: false, advisory: false, delta: 0, reasons };
  }

  const shrink = quality != null && Number.isFinite(quality) ? clamp(quality, 0.3, 1) : 1;
  let delta = -KETAMINE_CAP * score * shrink;
  // Never below the floor on this rule alone.
  delta = Math.max(delta, Math.min(0, KETAMINE_FLOOR - aligned));
  delta = Number(delta.toFixed(2));

  if (delta < 0) {
    reasons.push(
      `Ketamine is recorded for this case, so ${Math.abs(delta).toFixed(1)} index points of that fast activity are treated as drug effect rather than wakefulness (capped at ${KETAMINE_CAP}, and never taken below ${KETAMINE_FLOOR} on this rule alone).`,
    );
  }

  return {
    betaGamma,
    score: Number(score.toFixed(3)),
    exposure,
    corrected: delta < 0,
    advisory: false,
    delta,
    reasons,
  };
}

/** One-line summary for a badge or subtitle, or null when there is nothing to say. */
export function ketamineHint(k: KetamineSignature | null | undefined): string | null {
  if (!k) return null;
  if (k.corrected) {
    return `Ketamine correction −${Math.abs(k.delta).toFixed(0)}: fast-frequency activity treated as drug effect, not wakefulness.`;
  }
  if (k.advisory) {
    return "Ketamine-like beta/gamma pattern — if ketamine has been given, this index reads high. Record it to correct.";
  }
  if (k.exposure === "declared") {
    return "Ketamine recorded — the index is watched for spurious beta/gamma inflation.";
  }
  return null;
}
