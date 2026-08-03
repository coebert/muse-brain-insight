// Composite consciousness / nociception indices, in the spirit of qCON and
// qNOX (Quantium Medical, Conox monitor).
//
// The published qCON/qNOX are proprietary neural networks trained on clinical
// endpoints; their weights are not public. What IS public is the family of
// inputs they are built from: frontal EEG band-power ratios across delta,
// theta, alpha, beta and gamma, burst-suppression burden, spectral entropy,
// and — for the nociception index — the fast/high-frequency content and its
// short-term reactivity (frontalis EMG creeping into 30-47 Hz).
//
// This module builds a transparent, auditable index over the same inputs:
//   cIndex  0-99  hypnotic / consciousness scale, high = awake
//   nIndex  0-99  nociception-response scale, high = likely to respond to a
//                 noxious stimulus (i.e. under-analgesia)
//
// It is NOT qCON/qNOX, is not calibrated against clinical endpoints, and must
// not be used to titrate drugs. Treat it as a trend of its own inputs.

import type { BandPowers, PowerRatios } from "./analysis";
import type { SpectralEntropy } from "./dsp";

export interface CompositeReading {
  /** Consciousness / hypnotic index, 0-99. Null until enough clean data. */
  cIndex: number | null;
  /** Nociception-response index, 0-99. Null until enough clean data. */
  nIndex: number | null;
  /** Plain-language band for the consciousness index. */
  cBand: CompositeBand;
  /** Plain-language band for the nociception index. */
  nBand: NociceptionBand;
  /** Raw sub-scores, for audit and for the AI digest. */
  components: CompositeComponents;
  /** True while the last clean value is being held over artefact. */
  held: boolean;
}

export type CompositeBand =
  "awake" | "light_sedation" | "surgical" | "deep" | "burst_suppression" | "unreliable";

export type NociceptionBand = "well_controlled" | "adequate" | "likely_response" | "unreliable";

export interface CompositeComponents {
  /** Normalised fast/slow balance (beta+gamma vs delta+theta), 0-1. */
  fastSlow: number;
  /** Normalised state entropy (0.8-32 Hz), 0-1. */
  entropy: number;
  /** Suppression burden, %. */
  bsr: number;
  /** Frontal high-frequency (EMG-weighted) drive, 0-1. */
  emgDrive: number;
  /** Short-term reactivity of the high-frequency drive, 0-1. */
  reactivity: number;
  /** Response-minus-state entropy difference, 0-1. */
  entropyGap: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Logistic squash centred on `mid` with slope `k`. */
function sigmoid(x: number, mid: number, k: number): number {
  return 1 / (1 + Math.exp(-(x - mid) / k));
}

export function compositeBand(index: number | null, bsr: number): CompositeBand {
  if (index == null) return "unreliable";
  if (bsr >= 5 || index < 20) return "burst_suppression";
  if (index < 40) return "deep";
  if (index < 60) return "surgical";
  if (index < 80) return "light_sedation";
  return "awake";
}

export function nociceptionBand(index: number | null): NociceptionBand {
  if (index == null) return "unreliable";
  if (index < 40) return "well_controlled";
  if (index < 60) return "adequate";
  return "likely_response";
}

export const COMPOSITE_BAND_LABEL: Record<CompositeBand, string> = {
  awake: "Awake / responsive",
  light_sedation: "Light sedation",
  surgical: "Surgical range",
  deep: "Deep",
  burst_suppression: "Burst suppression",
  unreliable: "Unreliable",
};

export const NOCICEPTION_BAND_LABEL: Record<NociceptionBand, string> = {
  well_controlled: "Nociception well controlled",
  adequate: "Adequate analgesia",
  likely_response: "Response to stimulus likely",
  unreliable: "Unreliable",
};

export interface CompositeInput {
  bands: BandPowers;
  ratios: PowerRatios;
  entropy: SpectralEntropy;
  /** Suppression ratio over the trailing window, %. */
  suppressionRatio: number;
  /** Epoch is clean enough to update the indices. */
  usable: boolean;
}

/**
 * Streaming estimator. Both indices are exponentially smoothed (~15 s) so they
 * behave like a bedside monitor rather than a per-epoch scatter, and both hold
 * their last clean value across artefact-rejected epochs.
 */
export class CompositeIndexEstimator {
  /** Smoothing factor per 1 s hop — roughly a 15 s time constant. */
  private readonly alpha = 0.12;
  private readonly nAlpha = 0.2; // nociception should react faster
  private cSmoothed: number | null = null;
  private nSmoothed: number | null = null;
  private emgHistory: number[] = [];
  private cleanEpochs = 0;

  reset() {
    this.cSmoothed = null;
    this.nSmoothed = null;
    this.emgHistory = [];
    this.cleanEpochs = 0;
  }

  update(input: CompositeInput): CompositeReading {
    const { bands, entropy, suppressionRatio } = input;
    const total = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma || 1e-9;
    const slow = (bands.delta + bands.theta) / total;
    const fast = (bands.beta + bands.gamma) / total;
    // Log fast/slow balance keeps the scale sane when one side collapses.
    const fastSlow = clamp(sigmoid(Math.log10((fast + 1e-4) / (slow + 1e-4)), -1.1, 0.45), 0, 1);
    const stateEntropy = clamp(entropy.state, 0, 1);
    const emgDrive = clamp(sigmoid(Math.log10(bands.gamma / total + 1e-4), -1.9, 0.32), 0, 1);
    const entropyGap = clamp((entropy.response - entropy.state) * 4, 0, 1);

    if (input.usable) {
      this.emgHistory.push(emgDrive);
      if (this.emgHistory.length > 30) this.emgHistory.shift();
    }
    // Reactivity: how far the current high-frequency drive sits above its own
    // recent floor — a surrogate for stimulus-evoked frontalis activation.
    let reactivity = 0;
    if (this.emgHistory.length >= 5) {
      const floor = Math.min(...this.emgHistory);
      reactivity = clamp((emgDrive - floor) / 0.25, 0, 1);
    }

    if (!input.usable) {
      // Hold the last clean value; never invent a number over artefact.
      const cIndex = this.cSmoothed == null ? null : Math.round(this.cSmoothed);
      const nIndex = this.nSmoothed == null ? null : Math.round(this.nSmoothed);
      return {
        cIndex,
        nIndex,
        cBand: compositeBand(cIndex, suppressionRatio),
        nBand: nociceptionBand(nIndex),
        components: {
          fastSlow,
          entropy: stateEntropy,
          bsr: suppressionRatio,
          emgDrive,
          reactivity,
          entropyGap,
        },
        held: cIndex != null,
      };
    }

    this.cleanEpochs++;

    // --- consciousness index ------------------------------------------------
    // Spectral branch: fast/slow balance and entropy carry most of the signal;
    // a delta/alpha penalty pulls the index down as slowing consolidates.
    const slowingPenalty = clamp(
      sigmoid(Math.log10(input.ratios.deltaAlpha + 1e-3), 0.7, 0.4),
      0,
      1,
    );
    const spectral = clamp(
      100 * (0.5 * fastSlow + 0.38 * stateEntropy + 0.12 * (1 - slowingPenalty)),
      0,
      99,
    );
    // Suppression branch dominates once bursts appear, as in BIS/qCON: the
    // index is driven by burden alone below the burst-suppression threshold.
    const bsrBranch = clamp(50 - suppressionRatio * 1.25, 0, 50);
    const bsrWeight = clamp((suppressionRatio - 3) / 25, 0, 1);
    const cRaw = clamp((1 - bsrWeight) * spectral + bsrWeight * bsrBranch, 0, 99);

    // --- nociception index --------------------------------------------------
    // Under-analgesia shows as high-frequency drive, its reactivity, a widening
    // response-minus-state entropy gap and preserved fast cortical activity.
    const nRaw = clamp(
      100 *
        (0.34 * emgDrive + 0.26 * reactivity + 0.22 * entropyGap + 0.18 * fastSlow) *
        // Deep suppression makes the nociception estimate meaningless; damp it.
        (1 - clamp(suppressionRatio / 40, 0, 0.85)),
      0,
      99,
    );

    this.cSmoothed =
      this.cSmoothed == null ? cRaw : this.cSmoothed + this.alpha * (cRaw - this.cSmoothed);
    this.nSmoothed =
      this.nSmoothed == null ? nRaw : this.nSmoothed + this.nAlpha * (nRaw - this.nSmoothed);

    // Need ~10 s of clean data before showing anything.
    const mature = this.cleanEpochs >= 10;
    const cIndex = mature ? Math.round(this.cSmoothed) : null;
    const nIndex = mature ? Math.round(this.nSmoothed) : null;

    return {
      cIndex,
      nIndex,
      cBand: compositeBand(cIndex, suppressionRatio),
      nBand: nociceptionBand(nIndex),
      components: {
        fastSlow,
        entropy: stateEntropy,
        bsr: suppressionRatio,
        emgDrive,
        reactivity,
        entropyGap,
      },
      held: false,
    };
  }
}
