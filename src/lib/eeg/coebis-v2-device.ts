/**
 * Running COEBIS-2 on a live headband.
 *
 * The rebuilt index was fitted on one acquisition setup: bilateral frontal
 * electrodes sampled at 128 Hz, in real microvolts (`vitaldb-snuadc|AF7-AF8|128`).
 * A headband at the bedside differs from that in three ways that would quietly
 * corrupt the number if they were ignored:
 *
 *  1. **Rate.** The Muse streams at 256 Hz and the Regul8 band at 250 Hz. Band
 *     powers, edges and entropies are all rate-sensitive through the PSD, so
 *     the window is resampled onto the fitted 128 Hz before any descriptor is
 *     computed, rather than trusting the estimator to be rate-agnostic.
 *  2. **Montage.** The fit saw frontal electrodes. A Muse also has two
 *     behind-the-ear electrodes; a Regul8 has a single frontal differential.
 *     Whichever electrodes are used is stated with the reading, and a montage
 *     that is not bilateral frontal is labelled an extrapolation.
 *  3. **Amplitude.** Consumer bands with an unknown ADC scale are auto-gained,
 *     so `logRms`, `logPtp`, `logTotal` and the 5 µV suppression test have no
 *     fixed meaning. For those devices the stream is rescaled so its own
 *     typical amplitude matches the amplitude the model was fitted at, and the
 *     reading is flagged as amplitude-normalised. That makes the spectral
 *     shape terms usable; it does not make the absolute terms measurements.
 *
 * None of this turns an extrapolation into a validated reading. The held-out
 * error published for COEBIS-2 belongs to the fitted lineage only; on a
 * headband the number is a research reading and is labelled as one.
 */

import { resample } from "./ingest";
import {
  ANALYSIS_SAMPLE_RATE,
  CHANNEL_SIDE,
  type AnalysisChannel,
  type DeviceProfile,
} from "./device-profile";
import {
  COEBIS_V2_MODEL,
  CoebisV2Estimator,
  coebisV2Applicability,
  type CoebisV2Covariates,
  type CoebisV2Model,
  type CoebisV2Reading,
  type CoebisV2Applicability,
} from "./coebis-v2";

/** Sample rate the coefficients were fitted at. */
export const COEBIS_V2_FIT_RATE = 128;

/** Frontal positions the fit was trained on. */
const FRONTAL: AnalysisChannel[] = ["AF7", "AF8"];

/** Typical window RMS in the fitted corpus, in µV, from the model's own scaler. */
export function fittedReferenceRms(model: CoebisV2Model = COEBIS_V2_MODEL): number {
  const i = model.names.indexOf("logRms");
  return i < 0 ? 25 : Math.pow(10, model.mu[i] ?? 1.43);
}

export interface CoebisV2DeviceSetup {
  /** Electrodes feeding the index on this device. */
  channels: AnalysisChannel[];
  /** Electrodes present but deliberately left out. */
  excluded: AnalysisChannel[];
  applicability: CoebisV2Applicability;
  /** True when the stream is rescaled because its microvolt scale is unknown. */
  amplitudeNormalised: boolean;
  /** Plain-language caveats to show beside the number. */
  caveats: string[];
  /** One-line verdict for a badge. */
  verdict: string;
}

/**
 * How COEBIS-2 should be read on a given device.
 *
 * `useAllChannels` includes non-frontal electrodes in the analysis average.
 * That is the Muse default here by clinical choice — every electrode the band
 * records contributes — at the cost of moving further from the fitted montage,
 * which the caveats say outright.
 */
export function coebisV2DeviceSetup(
  profile: DeviceProfile,
  options: { useAllChannels?: boolean } = {},
): CoebisV2DeviceSetup {
  const useAll = options.useAllChannels ?? true;
  const frontal = profile.channels.filter((c) => FRONTAL.includes(c));
  const channels = useAll ? [...profile.channels] : frontal.length ? frontal : [...profile.channels];
  const excluded = profile.channels.filter((c) => !channels.includes(c));
  const nonFrontal = channels.filter((c) => !FRONTAL.includes(c));
  const bilateral =
    channels.some((c) => CHANNEL_SIDE[c] === "left") &&
    channels.some((c) => CHANNEL_SIDE[c] === "right");
  const amplitudeNormalised = profile.calibratedAmplitude === false;

  const applicability: CoebisV2Applicability =
    nonFrontal.length > 0 || !bilateral || amplitudeNormalised
      ? "extrapolated"
      : coebisV2Applicability(null, profile.sampleRate, channels);

  const caveats: string[] = [];
  if (profile.sampleRate !== COEBIS_V2_FIT_RATE) {
    caveats.push(
      `Recorded at ${profile.sampleRate} Hz and resampled to the ${COEBIS_V2_FIT_RATE} Hz the model was fitted at.`,
    );
  }
  if (nonFrontal.length) {
    caveats.push(
      `Includes ${nonFrontal.join(" and ")}, which the model never saw — it was fitted on forehead electrodes alone.`,
    );
  }
  if (!bilateral) {
    caveats.push(
      "One side of the head only, so the left/right terms the model was fitted with are unavailable.",
    );
  }
  if (amplitudeNormalised) {
    caveats.push(
      "This band does not report a microvolt scale, so its signal is rescaled to the typical size the model was fitted at. Shape-based terms carry the reading; absolute amplitude and the microvolt suppression test are relative to this recording.",
    );
  }
  if (excluded.length) {
    caveats.push(`${excluded.join(", ")} recorded but not used for this number.`);
  }

  const verdict =
    applicability === "fitted"
      ? "Same setup the model was fitted on"
      : applicability === "near"
        ? "Comparable forehead setup — readable, but the published error does not transfer"
        : "Outside the setup the model was fitted on — research reading only";

  return { channels, excluded, applicability, amplitudeNormalised, caveats, verdict };
}

export interface LiveCoebisV2Reading extends CoebisV2Reading {
  applicability: CoebisV2Applicability;
  amplitudeNormalised: boolean;
  /** Gain applied to the stream, 1 when the device is calibrated. */
  gain: number;
}

/**
 * Live COEBIS-2 for a headband: resamples onto the fitted rate, normalises
 * amplitude when the device has no microvolt scale, and carries the
 * estimator's trend memory across the case.
 */
export class LiveCoebisV2 {
  private readonly estimator: CoebisV2Estimator;
  private readonly setup: CoebisV2DeviceSetup;
  /** Output curve tuned to sedation labels; null means the raw model scale. */
  private tune: SedationTune | null = null;
  private logRmsEma: number | null = null;
  private gain = 1;

  constructor(
    profile: DeviceProfile,
    covariates: CoebisV2Covariates = {},
    options: { useAllChannels?: boolean; model?: CoebisV2Model; tune?: SedationTune | null } = {},
  ) {
    this.setup = coebisV2DeviceSetup(profile, options);
    this.tune = options.tune ?? null;
    this.estimator = new CoebisV2Estimator(covariates, options.model ?? COEBIS_V2_MODEL);
  }

  /**
   * Adopt (or clear) the sedation band curve. It is monotone, so it moves
   * where a reading sits on the scale without changing the order of readings.
   */
  setTune(tune: SedationTune | null): void {
    this.tune = tune;
  }

  get bandTuned(): boolean {
    return this.tune != null;
  }

  get deviceSetup(): CoebisV2DeviceSetup {
    return this.setup;
  }

  reset(): void {
    this.estimator.reset();
    this.logRmsEma = null;
    this.gain = 1;
  }

  /**
   * Feed one analysis window, sampled at the app's analysis rate.
   * Returns null until there is enough signal for a reading.
   */
  update(
    window: Float64Array,
    sampleRate: number = ANALYSIS_SAMPLE_RATE,
    stepSeconds = 1,
  ): LiveCoebisV2Reading | null {
    if (!window.length) return null;
    const fitted =
      sampleRate === COEBIS_V2_FIT_RATE
        ? window
        : resample(window, sampleRate, COEBIS_V2_FIT_RATE);
    const scaled = this.setup.amplitudeNormalised ? this.normalise(fitted) : fitted;
    const reading = this.estimator.update(scaled, COEBIS_V2_FIT_RATE, stepSeconds);
    if (!reading) return null;
    const tuned = this.tune
      ? {
          ...reading,
          index: Math.round(applyTune(this.tune, reading.index)),
          instant: applyTune(this.tune, reading.instant),
        }
      : reading;
    return {
      ...tuned,
      applicability: this.setup.applicability,
      amplitudeNormalised: this.setup.amplitudeNormalised,
      gain: this.gain,
      bandTuned: this.tune != null,
    };
  }

  /**
   * Rescales an auto-gained stream onto the amplitude the model was fitted at.
   * The gain follows a slow trailing average of the window RMS, so a single
   * artefact cannot move it and a genuine change in EEG amplitude over minutes
   * is preserved rather than normalised away within an epoch.
   */
  private normalise(window: Float64Array): Float64Array {
    let sumSquares = 0;
    for (let i = 0; i < window.length; i++) sumSquares += window[i]! * window[i]!;
    const rms = Math.sqrt(sumSquares / window.length);
    if (!Number.isFinite(rms) || rms <= 0) {
      return this.gain === 1 ? window : window.map((v) => v * this.gain);
    }
    const logRms = Math.log10(rms);
    // ~5 min time constant at one window per second.
    const alpha = this.logRmsEma == null ? 1 : 1 - Math.exp(-1 / 300);
    this.logRmsEma = this.logRmsEma == null ? logRms : this.logRmsEma + alpha * (logRms - this.logRmsEma);
    this.gain = Math.pow(10, Math.log10(fittedReferenceRms()) - this.logRmsEma);
    const out = new Float64Array(window.length);
    for (let i = 0; i < window.length; i++) out[i] = window[i]! * this.gain;
    return out;
  }
}
