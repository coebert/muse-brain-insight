/**
 * Published depth-of-anaesthesia indices, recomputed from a stored spectrum.
 *
 * COEBIS is only worth using if it beats what the literature already offers on
 * the *same* epochs and the *same* recorded labels. Comparing a published index
 * quoted from its own validation paper against COEBIS on our data is not a
 * comparison at all — different patients, different montage, different label
 * definition. So every comparator here is recomputed bin-by-bin from the
 * spectrum we stored for that epoch, from the algorithm as published:
 *
 *  - **State / Response Entropy** (Viertiö-Oja et al., Acta Anaesthesiol Scand
 *    2004;48:154-61) — normalised spectral entropy over 0.8-32 Hz and
 *    0.8-47 Hz, folded with burst suppression. Implemented in
 *    `entropy-monitor.ts` and reused here unchanged.
 *  - **Beta ratio** (Rampil, Anesthesiology 1998;89:980-1002) — log of the
 *    30-47 Hz to 11-20 Hz power ratio; the BIS subparameter that dominates the
 *    light-sedation end of the published BIS composite.
 *  - **Alpha/delta ratio** — the standard quantitative-EEG depth/encephalopathy
 *    marker used throughout the ICU literature, in dB.
 *  - **SEF95** is already stored per epoch and is graded alongside these.
 *
 * The bispectral subparameter of BIS proper (SynchFastSlow) needs the
 * bispectrum of the raw trace, which imported datasets do not carry, so it is
 * deliberately absent rather than approximated. Nothing here is presented as
 * "BIS": it is the published subparameter, not the proprietary composite.
 */

import { monitorEntropy } from "./entropy-monitor";

export interface PublishedIndices {
  /** GE/Datex State Entropy, 0-91. */
  stateEntropy: number | null;
  /** GE/Datex Response Entropy, 0-100. */
  responseEntropy: number | null;
  /** Rampil beta ratio, log10(P30-47 / P11-20). */
  betaRatio: number | null;
  /** Alpha/delta power ratio in dB. */
  alphaDelta: number | null;
}

export const EMPTY_PUBLISHED_INDICES: PublishedIndices = {
  stateEntropy: null,
  responseEntropy: null,
  betaRatio: null,
  alphaDelta: null,
};

/**
 * Linear power on a 0-based `binHz` grid from a stored dB spectrum.
 * Bins below `freqStart` are unmeasured and left at zero.
 */
export function powerFromDbSpectrum(
  spectrumDb: number[],
  freqStart: number,
  freqStep: number,
): { power: Float64Array; binHz: number } | null {
  if (!Array.isArray(spectrumDb) || spectrumDb.length < 4) return null;
  if (!(freqStep > 0)) return null;
  const offset = Math.max(0, Math.round(freqStart / freqStep));
  const power = new Float64Array(offset + spectrumDb.length);
  let finite = 0;
  for (let i = 0; i < spectrumDb.length; i++) {
    const db = Number(spectrumDb[i]);
    if (!Number.isFinite(db)) continue;
    power[offset + i] = Math.pow(10, db / 10);
    finite++;
  }
  if (finite < 4) return null;
  return { power, binHz: freqStep };
}

function bandPower(power: Float64Array, binHz: number, lo: number, hi: number): number {
  let sum = 0;
  const a = Math.max(0, Math.ceil(lo / binHz));
  const b = Math.min(power.length - 1, Math.floor(hi / binHz));
  for (let k = a; k <= b; k++) sum += power[k] ?? 0;
  return sum;
}

/** Rampil's BIS beta-ratio subparameter, log10(P30-47 / P11-20). */
export function betaRatioOf(power: Float64Array, binHz: number): number | null {
  const high = bandPower(power, binHz, 30, 47);
  const mid = bandPower(power, binHz, 11, 20);
  if (!(high > 0) || !(mid > 0)) return null;
  return Number((Math.log10(high / mid)).toFixed(4));
}

/** Alpha (8-13 Hz) to delta (0.5-4 Hz) power ratio, in dB. */
export function alphaDeltaOf(power: Float64Array, binHz: number): number | null {
  const alpha = bandPower(power, binHz, 8, 13);
  const delta = bandPower(power, binHz, 0.5, 4);
  if (!(alpha > 0) || !(delta > 0)) return null;
  return Number((10 * Math.log10(alpha / delta)).toFixed(3));
}

/** Alpha/delta from stored band powers, when no spectrum was kept. */
export function alphaDeltaFromBands(bands: Record<string, unknown> | null): number | null {
  const alpha = Number(bands?.["alpha"]);
  const delta = Number(bands?.["delta"]);
  if (!Number.isFinite(alpha) || !Number.isFinite(delta) || !(alpha > 0) || !(delta > 0)) {
    return null;
  }
  return Number((10 * Math.log10(alpha / delta)).toFixed(3));
}

/**
 * Every comparator index for one epoch.
 *
 * @param suppressionPct recorded/derived suppression ratio in percent; the
 *   entropy module folds it in exactly as the commercial monitor does.
 */
export function publishedIndices(
  spectrumDb: number[] | null,
  freqStart: number,
  freqStep: number,
  suppressionPct: number | null,
  bands: Record<string, unknown> | null = null,
): PublishedIndices {
  const grid = spectrumDb ? powerFromDbSpectrum(spectrumDb, freqStart, freqStep) : null;
  if (!grid) {
    return { ...EMPTY_PUBLISHED_INDICES, alphaDelta: alphaDeltaFromBands(bands) };
  }
  const { power, binHz } = grid;
  const entropy = monitorEntropy([power], suppressionPct ?? 0, binHz, 1);
  return {
    stateEntropy: entropy.se,
    responseEntropy: entropy.re,
    betaRatio: betaRatioOf(power, binHz),
    alphaDelta: alphaDeltaOf(power, binHz) ?? alphaDeltaFromBands(bands),
  };
}
