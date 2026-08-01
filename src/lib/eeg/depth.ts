// OpenIBIS-style depth-of-anaesthesia index.
//
// This is a transparent re-implementation in the spirit of the openibis
// algorithm (Connor CW, "Open Reimplementation of the BIS Algorithms for
// Depth of Anesthesia", Anesth Analg 2022), adapted for a single frontal
// channel from a consumer headband.
//
// Differences from the published algorithm that matter clinically:
//  - openibis derives SynchFastSlow from the bispectrum; here it is
//    approximated by a broadband/high-band power ratio, which tracks the
//    same underlying shift of power toward slow frequencies but is not
//    bicoherence. The output is therefore *BIS-like*, not BIS.
//  - the Muse montage is frontal but not the BIS sensor montage, and the
//    index is uncalibrated against clinical endpoints.
// Treat it as a trend, never as a target for drug titration on its own.

import { bandPower, type Psd } from "./dsp";

export interface DepthComponents {
  /** log10(P30–47 / P11–20) — rises with light anaesthesia / beta activation. */
  betaRatio: number;
  /** log10(P0.5–47 / P40–47) — proxy for SynchFastSlow; rises with slowing. */
  synchFastSlow: number;
  /** Burst-suppression ratio used by the mixer, 0–100 %. */
  bsr: number;
  sedationScore: number;
  generalScore: number;
  bsrScore: number;
}

export interface DepthReading {
  /** Smoothed 0–100 index. Null until enough clean data has accrued. */
  index: number | null;
  /** Unsmoothed instantaneous value. */
  raw: number | null;
  state: DepthState;
  components: DepthComponents;
}

export type DepthState =
  | "unreliable"
  | "awake"
  | "sedated"
  | "general_anaesthesia"
  | "deep"
  | "burst_suppression";

export const DEPTH_STATE_LABEL: Record<DepthState, string> = {
  unreliable: "Signal too poor",
  awake: "Awake / very light",
  sedated: "Sedated / light",
  general_anaesthesia: "General anaesthesia",
  deep: "Deep anaesthesia",
  burst_suppression: "Burst suppression",
};

/** Sigmoid used by openibis to map a subparameter onto the 0–100 scale. */
function scurve(x: number, eo: number, emax: number, x50: number, xwidth: number): number {
  return eo - emax / (1 + Math.exp((x - x50) / xwidth));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function depthState(index: number | null, bsr: number): DepthState {
  if (index == null) return "unreliable";
  if (bsr >= 5 || index < 20) return "burst_suppression";
  if (index < 40) return "deep";
  if (index < 60) return "general_anaesthesia";
  if (index < 80) return "sedated";
  return "awake";
}

export function depthTone(state: DepthState): "default" | "signal" | "caution" | "critical" {
  switch (state) {
    case "general_anaesthesia":
      return "signal";
    case "awake":
    case "sedated":
    case "deep":
      return "caution";
    case "burst_suppression":
      return "critical";
    default:
      return "default";
  }
}

export function depthComponents(psd: Psd, bsr: number): DepthComponents {
  const eps = 1e-9;
  const pHigh = bandPower(psd, 30, 47) + eps;
  const pMid = bandPower(psd, 11, 20) + eps;
  const pBroad = bandPower(psd, 0.5, 47) + eps;
  const pFast = bandPower(psd, 40, 47) + eps;

  const betaRatio = Math.log10(pHigh / pMid);
  const synchFastSlow = Math.log10(pBroad / pFast);

  // Sigmoid fits reproduce the openibis shape: more slowing (higher
  // SynchFastSlow) and less relative beta both drive the index down.
  const sedationScore = clamp(scurve(synchFastSlow, 104.4, 49.4, 1.9, -0.55), 0, 100);
  const generalScore = clamp(scurve(betaRatio, 97.6, 89.2, -1.1, 0.42), 0, 100);
  // Deep suppression pulls the index toward zero, as in the BIS BSR branch.
  const bsrScore = clamp(50 - bsr / 2, 0, 50);

  return { betaRatio, synchFastSlow, bsr, sedationScore, generalScore, bsrScore };
}

const SMOOTH_EPOCHS = 15; // BIS-like 15 s trend smoothing

/** Stateful estimator: feed one PSD + suppression ratio per epoch. */
export class DepthIndexEstimator {
  private history: number[] = [];

  reset() {
    this.history = [];
  }

  update(psd: Psd, bsr: number, qualityScore: number, artifact: boolean): DepthReading {
    const c = depthComponents(psd, bsr);

    // Awake/anaesthetised blend, then hand over to the suppression branch as
    // burst suppression takes over the record.
    const spectralScore = 0.5 * c.sedationScore + 0.5 * c.generalScore;
    const w = clamp(bsr / 40, 0, 1);
    const raw = clamp((1 - w) * spectralScore + w * c.bsrScore, 0, 100);

    if (!artifact && qualityScore >= 0.35) {
      this.history.push(raw);
      if (this.history.length > SMOOTH_EPOCHS) this.history.shift();
    }

    const index = this.history.length
      ? this.history.reduce((a, b) => a + b, 0) / this.history.length
      : null;

    return {
      index: index == null ? null : Math.round(index),
      raw: Math.round(raw),
      state: depthState(index == null ? null : Math.round(index), bsr),
      components: c,
    };
  }
}
