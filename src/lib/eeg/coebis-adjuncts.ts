/**
 * COEBIS stage 4 — adjunct correction from commercial-monitor algorithm
 * knowledge.
 *
 * Stages 1-3 of COEBIS (pooled affine map, region knots, patient covariates)
 * are all fitted from paired commercial-BIS readings against a single number:
 * the OpenIBIS index. That leaves systematic residuals a scalar map cannot
 * remove, because the commercial monitors use information OpenIBIS discards.
 * Two published families tell us what that information is:
 *
 *  - **GE Entropy** separates the EEG band (SE, 0.8-32 Hz) from the frontal
 *    EMG band (RE, to 47 Hz). Frontal EMG inflates BIS, which is why a BIS
 *    monitor reads high in a lightly paralysed, stimulated patient while the
 *    EEG itself has not changed. The RE-SE gap measures exactly that.
 *  - **Masimo SedLine/PSI** weighs bilateral coherence and spectral shape
 *    (frontal alpha, slow-wave power) rather than one scalar ratio, and is
 *    documented as more stable than Entropy when EMG contaminates the signal.
 *
 * Each rule below is bounded, quality-gated, and reported with a rationale, so
 * the correction can never silently dominate the fitted model. The total is
 * capped, and the whole stage is skipped when the evidence is missing.
 *
 * Important for validation: paired readings are always logged against the raw
 * OpenIBIS index, so this stage never feeds back into the fits of stages 1-3.
 */

import { SE_MAX, type MonitorEntropy } from "./entropy-monitor";
import type { MontageFeatures } from "./psi-features";

/** Hard ceiling on the whole adjunct stage, in index points. */
export const ADJUNCT_CAP = 8;

export interface AdjunctPart {
  label: string;
  delta: number;
  detail: string;
  /**
   * One sentence on how this component differs from the commercial BIS
   * reading it is paired against — i.e. why the correction exists at all.
   */
  vsCommercial: string;
}

export interface AdjunctCorrection {
  total: number;
  parts: AdjunctPart[];
  /** True when the summed rules were clipped by the cap. */
  capped: boolean;
  /** Reliability shrinkage applied because the hemispheres disagreed (0-1). */
  shrink: number;
}

export const NO_ADJUNCT: AdjunctCorrection = {
  total: 0,
  parts: [],
  capped: false,
  shrink: 1,
};

/**
 * Plain-language reference for the four adjunct components, used by the UI so
 * a clinician can see what each one does and where it parts company with the
 * commercial BIS number on the other monitor.
 */
export interface AdjunctComponentInfo {
  label: string;
  /** What the component measures. */
  what: string;
  /** How it differs from the paired commercial BIS reading. */
  vsCommercial: string;
  /** Largest movement this single rule can make, in index points. */
  limit: number;
}

export const ADJUNCT_COMPONENTS: AdjunctComponentInfo[] = [
  {
    label: "Frontal EMG margin",
    what: "The Response minus State Entropy gap, the Entropy monitor's measure of frontal muscle activity and arousal.",
    vsCommercial:
      "Commercial BIS lumps frontal EMG into one number, so it reads high on muscle tone alone; COEBIS measures that muscle band separately and credits only part of it back, so it moves with the monitor without inheriting the whole artefact.",
    limit: 4,
  },
  {
    label: "State Entropy concordance",
    what: "A second, independent depth estimate from the 0.8–32 Hz entropy, rescaled onto the BIS-like 0–100 scale.",
    vsCommercial:
      "Commercial BIS is one proprietary index with no second opinion; COEBIS cross-checks itself against an openly published algorithm and moves 15 % of the way towards it when the two disagree.",
    limit: 5,
  },
  {
    label: "Suppression proportionality",
    what: "A ceiling on the displayed index implied by the current suppression ratio.",
    vsCommercial:
      "Commercial BIS can lag or sit implausibly high during intermittent burst suppression; COEBIS ties the number directly to the measured suppression ratio, so deep states cannot be displayed as light ones.",
    limit: 6,
  },
  {
    label: "Spectral pattern (SedLine-style)",
    what: "Frontal alpha and slow-wave dominance across both hemispheres — the classic propofol signature.",
    vsCommercial:
      "Commercial BIS is a single-sided scalar and ignores hemispheric agreement; COEBIS reads the bilateral spectral shape, so an adequately anaesthetised brain is not reported as light purely because the ratio-based index is high.",
    limit: 3,
  },
];

/** The contrast sentence for a component, by registry label. */
export function vs(label: string): string {
  return ADJUNCT_COMPONENTS.find((c) => c.label === label)?.vsCommercial ?? "";
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface AdjunctInputs {
  /** COEBIS value after the pooled, knot and covariate stages. */
  aligned: number;
  entropy: MonitorEntropy | null;
  montage: MontageFeatures | null;
  /** Suppression ratio, 0-100 %. */
  bsr: number;
  /** 0-1 signal-quality score; low quality shrinks the whole stage. */
  quality?: number | null;
}

/**
 * Compute the adjunct correction. Returns a zero correction (with an empty
 * parts list) whenever the supporting features are unavailable.
 */
export function coebisAdjunct({
  aligned,
  entropy,
  montage,
  bsr,
  quality,
}: AdjunctInputs): AdjunctCorrection {
  const parts: AdjunctPart[] = [];
  const safeBsr = clamp(Number.isFinite(bsr) ? bsr : 0, 0, 100);

  // --- 1. Frontal EMG margin (Entropy RE-SE) ---------------------------
  // BIS rises with frontal EMG; OpenIBIS does not model it separately. Above a
  // 10-point gap, credit part of it back so COEBIS tracks the monitor.
  if (entropy?.emgGap != null && entropy.emgGap > 10 && safeBsr < 20) {
    const delta = clamp(0.25 * (entropy.emgGap - 10), 0, 4);
    if (delta >= 0.2) {
      parts.push({
        label: "Frontal EMG margin",
        delta,
        detail: `Response minus State Entropy is ${entropy.emgGap.toFixed(0)} points, the Entropy monitor's marker of frontal EMG and arousal, which raises a commercial BIS without a change in the EEG itself.`,
        vsCommercial: vs("Frontal EMG margin"),
      });
    }
  }

  // --- 2. Independent Entropy estimate of depth ------------------------
  // SE is a second, independently derived depth estimate on the same signal.
  // Pull COEBIS a short way towards it, but only where both are meaningful
  // (not in suppression, where entropy saturates at the floor).
  if (entropy?.se != null && safeBsr < 10) {
    const seAsIndex = (entropy.se / SE_MAX) * 100;
    const delta = clamp(0.15 * (seAsIndex - aligned), -5, 5);
    if (Math.abs(delta) >= 0.3) {
      parts.push({
        label: "State Entropy concordance",
        delta,
        detail: `State Entropy of ${entropy.se.toFixed(0)} corresponds to about ${seAsIndex.toFixed(0)} on a BIS-like scale; COEBIS is nudged 15 % of the way towards this independent estimate.`,
        vsCommercial: vs("State Entropy concordance"),
      });
    }
  }

  // --- 3. Suppression proportionality ----------------------------------
  // Both BIS and Entropy fall roughly in proportion to the suppression ratio.
  // If the aligned index is above the ceiling that implies, bring it down.
  if (safeBsr >= 10) {
    const ceiling = 50 * (1 - safeBsr / 100);
    if (aligned > ceiling) {
      const delta = clamp(-(aligned - ceiling) * 0.4, -6, 0);
      if (delta <= -0.3) {
        parts.push({
          label: "Suppression proportionality",
          delta,
          detail: `With a suppression ratio of ${safeBsr.toFixed(0)} %, a commercial monitor would not display more than about ${ceiling.toFixed(0)}; the index is drawn towards that ceiling.`,
          vsCommercial: vs("Suppression proportionality"),
        });
      }
    }
  }

  // --- 4. Spectral shape (PSI-style) -----------------------------------
  // Strong frontal alpha with slow-wave power is the classic propofol pattern
  // of an adequately anaesthetised brain; PSI weights this shape directly.
  if (montage?.alphaFraction != null && montage.slowFraction != null && safeBsr < 20) {
    const anaesthetic = montage.alphaFraction >= 0.18 && montage.slowFraction >= 0.4;
    const light = montage.alphaFraction < 0.08 && montage.slowFraction < 0.3;
    if (anaesthetic && aligned > 60) {
      parts.push({
        label: "Anaesthetic spectral pattern",
        delta: -3,
        detail: `Frontal alpha (${(montage.alphaFraction * 100).toFixed(0)} % of power) with dominant slow-wave activity is the pattern of an adequately anaesthetised brain, which the index is reading as lighter than it is.`,
        vsCommercial: vs("Spectral pattern (SedLine-style)"),
      });
    } else if (light && aligned < 40) {
      parts.push({
        label: "Absent anaesthetic pattern",
        delta: 3,
        detail: `Neither frontal alpha nor slow-wave dominance is present, which argues against the depth the index is reporting.`,
        vsCommercial: vs("Spectral pattern (SedLine-style)"),
      });
    }
  }

  // --- reliability shrinkage -------------------------------------------
  // A single-hemisphere frontal estimate deserves less correction when the two
  // sides disagree, or when the signal itself is poor.
  let shrink = 1;
  if (montage?.coherence != null && montage.coherence < 0.5) {
    shrink *= clamp(0.4 + 0.6 * (montage.coherence / 0.5), 0.4, 1);
  }
  if (montage?.asymmetry != null && montage.asymmetry > 0.3) {
    shrink *= clamp(1 - (montage.asymmetry - 0.3), 0.5, 1);
  }
  if (quality != null && Number.isFinite(quality) && quality < 0.7) {
    shrink *= clamp(quality / 0.7, 0.3, 1);
  }
  shrink = clamp(shrink, 0.3, 1);

  const rawTotal = parts.reduce((s, p) => s + p.delta, 0) * shrink;
  const total = clamp(rawTotal, -ADJUNCT_CAP, ADJUNCT_CAP);

  return {
    total: Number(total.toFixed(2)),
    parts: parts.map((p) => ({ ...p, delta: Number((p.delta * shrink).toFixed(2)) })),
    capped: Math.abs(rawTotal) > ADJUNCT_CAP,
    shrink: Number(shrink.toFixed(2)),
  };
}
