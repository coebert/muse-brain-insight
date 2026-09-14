/**
 * Reading COEBIS-2 on a stored spectrum.
 *
 * Imported collections keep a power spectrum per epoch, not the waveform, so
 * the estimator cannot be run the way it runs at the bedside. Everything it
 * needs *is* spectral except three terms — root-mean-square amplitude,
 * peak-to-peak amplitude and the suppression fraction — so those are
 * reconstructed explicitly here rather than left at zero:
 *
 *  - RMS comes from the integrated 0.5-45 Hz power (Parseval), which is exact
 *    for the band the fit uses.
 *  - Peak-to-peak is approximated as six standard deviations, the usual
 *    Gaussian-amplitude convention. It is an approximation, and the only one.
 *  - The suppression fraction is the collection's own recorded suppression
 *    ratio, never a value this app invented.
 *
 * The result is a genuine COEBIS-2 reading on those epochs, but on a montage
 * the coefficients were not fitted to. {@link coebisV2Applicability} labels
 * that, and every summary built on it must carry the label through.
 */

import {
  CoebisV2Estimator,
  coebisV2SpectralFeatures,
  type CoebisV2Covariates,
  type CoebisV2Features,
} from "./coebis-v2";
import type { Psd } from "./dsp";
import { powerFromDbSpectrum } from "./published-indices";

/** One stored epoch, in the order it was recorded. */
export interface StoredSpectrum {
  atSeconds: number;
  spectrumDb: number[] | null;
  freqStart: number;
  freqStep: number;
  /** Recorded suppression ratio in percent, when the collection published one. */
  suppressionPct: number | null;
}

/** A power spectral density on the stored dB grid. */
export function psdFromStoredSpectrum(
  spectrumDb: number[] | null,
  freqStart: number,
  freqStep: number,
): Psd | null {
  if (!spectrumDb) return null;
  const grid = powerFromDbSpectrum(spectrumDb, freqStart, freqStep);
  if (!grid) return null;
  const freqs = new Float64Array(grid.power.length);
  for (let i = 0; i < freqs.length; i++) freqs[i] = i * grid.binHz;
  return { freqs, power: grid.power, binWidth: grid.binHz };
}

const L = (x: number) => Math.log10(Math.max(x, 1e-9));

function bandPower(psd: Psd, lo: number, hi: number): number {
  let sum = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f >= lo && f < hi) sum += psd.power[i]! * psd.binWidth;
  }
  return sum;
}

/** The full model row for one stored epoch, amplitude terms included. */
export function featuresFromStoredSpectrum(
  epoch: StoredSpectrum,
): { features: CoebisV2Features; suppressionFraction: number } | null {
  const psd = psdFromStoredSpectrum(epoch.spectrumDb, epoch.freqStart, epoch.freqStep);
  if (!psd) return null;
  const spectral = coebisV2SpectralFeatures(psd);
  const variance = Math.max(bandPower(psd, 0.5, 45), 1e-12);
  const rms = Math.sqrt(variance);
  const suppressionFraction = Math.min(
    1,
    Math.max(0, (epoch.suppressionPct ?? 0) / 100),
  );
  return {
    suppressionFraction,
    features: {
      ...spectral,
      logRms: L(rms),
      logPtp: L(6 * rms),
      suppFraction: suppressionFraction,
    },
  };
}

export interface SpectralReading {
  atSeconds: number;
  index: number;
  instant: number;
  suppressionRatio: number;
}

/**
 * Score one case's stored epochs in recorded order, carrying the estimator's
 * trend memory and output smoothing exactly as a live case would.
 */
export function scoreStoredCase(
  epochs: StoredSpectrum[],
  covariates: CoebisV2Covariates = {},
): SpectralReading[] {
  const ordered = [...epochs].sort((a, b) => a.atSeconds - b.atSeconds);
  const estimator = new CoebisV2Estimator(covariates);
  const out: SpectralReading[] = [];
  let previous: number | null = null;
  for (const epoch of ordered) {
    const built = featuresFromStoredSpectrum(epoch);
    if (!built) continue;
    const step =
      previous == null ? 1 : Math.min(60, Math.max(1, epoch.atSeconds - previous));
    previous = epoch.atSeconds;
    const reading = estimator.updateFromFeatures(
      built.features,
      built.suppressionFraction,
      step,
    );
    out.push({
      atSeconds: epoch.atSeconds,
      index: reading.index,
      instant: reading.instant,
      suppressionRatio: reading.suppressionRatio,
    });
  }
  return out;
}
