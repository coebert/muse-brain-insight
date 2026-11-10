/**
 * Reading COEBIS-2 on a stored spectrum — only when every input is measured.
 *
 * Imported collections keep a power spectrum per epoch, not the waveform.
 * COEBIS-2 was fitted on waveform-derived terms that a spectrum cannot supply:
 *
 *  - `logPtp` — the largest 0.5 s peak-to-peak amplitude. A spectrum carries
 *    no phase, so peak-to-peak cannot be recovered from it. A "six standard
 *    deviations" Gaussian convention is an estimate, not a measurement, and is
 *    no longer substituted.
 *  - `suppFraction` / `sr60` — the share of 0.5 s segments below 5 µV
 *    peak-to-peak. A collection's own published suppression ratio uses a
 *    different detector and window, so it is not the same quantity, and a
 *    missing value is never read as 0 % suppression.
 *  - Absolute power terms need a spectrum in real µV²/Hz.
 *
 * So an epoch is scored only when it carries a measured peak-to-peak, a
 * suppression fraction measured with the model's own 5 µV / 0.5 s definition,
 * and a calibrated spectrum. Anything else returns an explicit unavailable
 * result naming what is missing. RMS is derived from the integrated 0.5–45 Hz
 * power (Parseval), which is exact for that band on a calibrated spectrum, and
 * is labelled as derived.
 *
 * Spectrum-only collections therefore cannot produce COEBIS-2 numbers until
 * they are reprocessed from their original waveforms.
 */

import {
  CoebisV2Estimator,
  COEBIS_V2_SUPPRESSION_UV,
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
  /**
   * The collection's own published suppression ratio, %. Kept for context
   * only: it is a different detector from the model's 5 µV test and is never
   * substituted for it.
   */
  suppressionPct: number | null;
  /** Largest 0.5 s peak-to-peak in µV, measured on the original waveform. */
  peakToPeakUv?: number | null;
  /**
   * Fraction (0–1) of 0.5 s segments below the model's 5 µV threshold,
   * measured on the original waveform.
   */
  suppressionFraction5uv?: number | null;
  /** False when the spectrum is not in real µV²/Hz. Absent means unknown. */
  amplitudeCalibrated?: boolean | null;
}

/** Inputs the full model needs that a stored epoch may lack. */
export type StoredSpectrumInput =
  | "spectrum"
  | "measured-peak-to-peak"
  | "measured-5uv-suppression"
  | "calibrated-amplitude";

export type StoredFeatures =
  | {
      available: true;
      features: CoebisV2Features;
      suppressionFraction: number;
      /** Terms computed from the spectrum rather than read off the waveform. */
      derived: string[];
    }
  | { available: false; missing: StoredSpectrumInput[]; reason: string };

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

const finite = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v);

const MISSING_TEXT: Record<StoredSpectrumInput, string> = {
  spectrum: "no readable spectrum",
  "measured-peak-to-peak": "no measured peak-to-peak amplitude (cannot be recovered from a spectrum)",
  "measured-5uv-suppression": `no suppression fraction measured with the model's ${COEBIS_V2_SUPPRESSION_UV} µV / 0.5 s test`,
  "calibrated-amplitude": "spectrum not confirmed to be in real microvolts",
};

export function describeMissingInputs(missing: StoredSpectrumInput[]): string {
  return `COEBIS-2 unavailable: ${missing.map((m) => MISSING_TEXT[m]).join("; ")}.`;
}

/**
 * The full model row for one stored epoch — or an explicit unavailable
 * result when any input the fit requires was not genuinely measured.
 */
export function featuresFromStoredSpectrum(epoch: StoredSpectrum): StoredFeatures {
  const missing: StoredSpectrumInput[] = [];
  const psd = psdFromStoredSpectrum(epoch.spectrumDb, epoch.freqStart, epoch.freqStep);
  if (!psd) missing.push("spectrum");
  if (!finite(epoch.peakToPeakUv) || epoch.peakToPeakUv! <= 0) missing.push("measured-peak-to-peak");
  if (
    !finite(epoch.suppressionFraction5uv) ||
    epoch.suppressionFraction5uv! < 0 ||
    epoch.suppressionFraction5uv! > 1
  ) {
    missing.push("measured-5uv-suppression");
  }
  if (epoch.amplitudeCalibrated !== true) missing.push("calibrated-amplitude");
  if (missing.length || !psd) {
    return { available: false, missing, reason: describeMissingInputs(missing) };
  }

  const spectral = coebisV2SpectralFeatures(psd);
  const rms = Math.sqrt(Math.max(bandPower(psd, 0.5, 45), 1e-12));
  const suppressionFraction = epoch.suppressionFraction5uv!;
  return {
    available: true,
    suppressionFraction,
    derived: ["logRms (Parseval over 0.5–45 Hz)"],
    features: {
      ...spectral,
      logRms: L(rms),
      logPtp: L(epoch.peakToPeakUv!),
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

export interface StoredCaseScore {
  readings: SpectralReading[];
  /** Epochs that could not be scored because inputs were missing. */
  unavailable: number;
  /** How often each input was missing, across the case. */
  missing: Partial<Record<StoredSpectrumInput, number>>;
  /** Plain-language reason when nothing could be scored, else null. */
  reason: string | null;
}

/**
 * Score one case's stored epochs in recorded order, carrying the estimator's
 * trend memory and output smoothing exactly as a live case would. Epochs
 * missing a required measured input are counted, never filled in. Because the
 * model's trend memory assumes contiguous input, an unavailable epoch resets
 * the estimator rather than being bridged.
 */
export function scoreStoredCase(
  epochs: StoredSpectrum[],
  covariates: CoebisV2Covariates = {},
): StoredCaseScore {
  const ordered = [...epochs].sort((a, b) => a.atSeconds - b.atSeconds);
  const estimator = new CoebisV2Estimator(covariates);
  const readings: SpectralReading[] = [];
  const missing: Partial<Record<StoredSpectrumInput, number>> = {};
  let unavailable = 0;
  let previous: number | null = null;
  for (const epoch of ordered) {
    const built = featuresFromStoredSpectrum(epoch);
    if (!built.available) {
      unavailable++;
      for (const m of built.missing) missing[m] = (missing[m] ?? 0) + 1;
      estimator.reset();
      previous = null;
      continue;
    }
    const step =
      previous == null ? 1 : Math.min(60, Math.max(1, epoch.atSeconds - previous));
    previous = epoch.atSeconds;
    const reading = estimator.updateFromFeatures(
      built.features,
      built.suppressionFraction,
      step,
    );
    readings.push({
      atSeconds: epoch.atSeconds,
      index: reading.index,
      instant: reading.instant,
      suppressionRatio: reading.suppressionRatio,
    });
  }
  const reason =
    readings.length === 0 && unavailable > 0
      ? describeMissingInputs(Object.keys(missing) as StoredSpectrumInput[])
      : null;
  return { readings, unavailable, missing, reason };
}

/** Merge per-case unavailability into one summary for a read-out. */
export function summariseUnavailable(scores: StoredCaseScore[]): {
  epochs: number;
  reason: string | null;
} {
  const epochs = scores.reduce((a, s) => a + s.unavailable, 0);
  const keys = new Set<StoredSpectrumInput>();
  for (const s of scores) for (const k of Object.keys(s.missing)) keys.add(k as StoredSpectrumInput);
  return { epochs, reason: epochs ? describeMissingInputs([...keys]) : null };
}
