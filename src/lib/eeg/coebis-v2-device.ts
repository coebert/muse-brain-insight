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
 *  3. **Amplitude.** The fitted model depends on absolute microvolt terms
 *     (`logRms`, `logPtp`, `logTotal`, absolute band powers, the 5 µV
 *     suppression fraction and every trend built on them). A band with an
 *     unknown ADC scale cannot supply those terms. Rescaling its signal to the
 *     training RMS would manufacture them, so it is **not** done: COEBIS-2 and
 *     its suppression ratio are withheld with an explicit reason, and only the
 *     scale-invariant relative spectral descriptors are reported, as research
 *     features. No amplitude-independent model has been trained; none is
 *     substituted.
 *
 * None of this turns an extrapolation into a validated reading. The held-out
 * BIS-agreement published for COEBIS-2 belongs to the fitted lineage only; on
 * a headband the number is a research reading and is labelled as one.
 */

import { applyTune, type SedationTune } from "./coebis-sedation-bands";
import { computePsd } from "./dsp";
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
  coebisV2SpectralFeatures,
  type CoebisV2Covariates,
  type CoebisV2Features,
  type CoebisV2Model,
  type CoebisV2Applicability,
} from "./coebis-v2";

/** Sample rate the coefficients were fitted at. */
export const COEBIS_V2_FIT_RATE = 128;

/** Frontal positions the fit was trained on. */
const FRONTAL: AnalysisChannel[] = ["AF7", "AF8"];

/**
 * Spectral descriptors that do not change when the whole window is multiplied
 * by a constant — ratios, relative powers, edges, entropies and peak shape.
 * These stay meaningful on a band whose microvolt scale is unknown.
 */
export const COEBIS_V2_RELATIVE_FEATURES = [
  "relSlow",
  "relDelta",
  "relTheta",
  "relAlpha",
  "relBeta",
  "relGamma",
  "betaRatio",
  "syncFastSlow",
  "alphaDelta",
  "thetaAlpha",
  "sef50",
  "sef75",
  "sef90",
  "sef95",
  "entShannon",
  "entSe95",
  "entState",
  "entResponse",
  "peakFreq",
  "peakProminence",
] as const;

/** Reason shown wherever COEBIS-2 is withheld for an uncalibrated band. */
export const UNCALIBRATED_AMPLITUDE_REASON =
  "Withheld: this band does not report a microvolt scale. COEBIS-2 was fitted on absolute amplitude and the 5 µV suppression test, so neither the index nor its suppression ratio can be computed. Only relative spectral research features are shown.";

export interface CoebisV2DeviceSetup {
  /** Electrodes feeding the index on this device. */
  channels: AnalysisChannel[];
  /** Electrodes present but deliberately left out. */
  excluded: AnalysisChannel[];
  applicability: CoebisV2Applicability;
  /** True when samples arrive in real microvolts. */
  amplitudeCalibrated: boolean;
  /** Non-null when COEBIS-2 output is withheld on this device, and why. */
  withheldReason: string | null;
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
  const amplitudeCalibrated = profile.calibratedAmplitude !== false;
  const withheldReason = amplitudeCalibrated ? null : UNCALIBRATED_AMPLITUDE_REASON;

  const applicability: CoebisV2Applicability =
    nonFrontal.length > 0 || !bilateral || !amplitudeCalibrated
      ? "extrapolated"
      : coebisV2Applicability(null, profile.sampleRate, channels);

  const caveats: string[] = [];
  if (!amplitudeCalibrated) caveats.push(UNCALIBRATED_AMPLITUDE_REASON);
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
  if (excluded.length) {
    caveats.push(`${excluded.join(", ")} recorded but not used for this number.`);
  }

  const verdict = withheldReason
    ? "Withheld — amplitude scale unknown"
    : applicability === "fitted"
      ? "Same setup the model was fitted on"
      : applicability === "near"
        ? "Comparable forehead setup — readable, but the published error does not transfer"
        : "Outside the setup the model was fitted on — research reading only";

  return { channels, excluded, applicability, amplitudeCalibrated, withheldReason, caveats, verdict };
}

export interface LiveCoebisV2Reading {
  /** "withheld" when the inputs the model needs cannot be measured. */
  status: "available" | "withheld";
  /** Smoothed index 0–100, null when withheld. */
  index: number | null;
  /** Unsmoothed index, null when withheld. */
  instant: number | null;
  /** Trailing 60 s suppression ratio, %, null when withheld. */
  suppressionRatio: number | null;
  /** Every model term's value; null when the model was not run. */
  terms: CoebisV2Features | null;
  /** Largest signed contributions; empty when withheld. */
  drivers: { term: string; contribution: number }[];
  /** Why the index is withheld, null when available. */
  withheldReason: string | null;
  /** Scale-invariant spectral descriptors, always reported, research use only. */
  researchFeatures: Partial<Record<(typeof COEBIS_V2_RELATIVE_FEATURES)[number], number>>;
  applicability: CoebisV2Applicability;
  amplitudeCalibrated: boolean;
  /** True when the sedation band curve is in force on this reading. */
  bandTuned: boolean;
  /** Model version this reading was computed with (frozen for the recording). */
  modelVersion: string;
}

/** Stable identifier for the active COEBIS-2 coefficients. */
export function coebisV2ModelVersion(model: CoebisV2Model = COEBIS_V2_MODEL): string {
  return `coebis-v2|${model.meta.lineage}|${model.meta.fittedAt}`;
}

function relativeFeatures(
  features: CoebisV2Features,
): LiveCoebisV2Reading["researchFeatures"] {
  const out: LiveCoebisV2Reading["researchFeatures"] = {};
  for (const k of COEBIS_V2_RELATIVE_FEATURES) {
    const v = features[k];
    if (v != null && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Live COEBIS-2 for a headband: resamples onto the fitted rate, refuses to run
 * the absolute-amplitude model when the device has no microvolt scale, and
 * carries the estimator's trend memory across the case.
 *
 * The output curve (sedation tune) is fixed at construction: a recording is
 * scored with one configuration from start to finish. A newer curve is picked
 * up by the next recording, never mid-case.
 */
export class LiveCoebisV2 {
  private readonly estimator: CoebisV2Estimator;
  private readonly setup: CoebisV2DeviceSetup;
  private readonly model: CoebisV2Model;
  /** Output curve tuned to sedation labels; null means the raw model scale. */
  private readonly tune: SedationTune | null;

  constructor(
    profile: DeviceProfile,
    covariates: CoebisV2Covariates = {},
    options: { useAllChannels?: boolean; model?: CoebisV2Model; tune?: SedationTune | null } = {},
  ) {
    this.setup = coebisV2DeviceSetup(profile, options);
    this.tune = options.tune ?? null;
    this.model = options.model ?? COEBIS_V2_MODEL;
    this.estimator = new CoebisV2Estimator(covariates, this.model);
  }

  get bandTuned(): boolean {
    return this.tune != null;
  }

  get deviceSetup(): CoebisV2DeviceSetup {
    return this.setup;
  }

  get modelVersion(): string {
    return coebisV2ModelVersion(this.model);
  }

  reset(): void {
    this.estimator.reset();
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
    const common = {
      applicability: this.setup.applicability,
      amplitudeCalibrated: this.setup.amplitudeCalibrated,
      bandTuned: this.tune != null,
      modelVersion: this.modelVersion,
    };

    if (!this.setup.amplitudeCalibrated) {
      if (fitted.length < 2 * COEBIS_V2_FIT_RATE) return null;
      const spectral = coebisV2SpectralFeatures(computePsd(fitted, COEBIS_V2_FIT_RATE));
      return {
        ...common,
        status: "withheld",
        index: null,
        instant: null,
        suppressionRatio: null,
        terms: null,
        drivers: [],
        withheldReason: this.setup.withheldReason,
        researchFeatures: relativeFeatures(spectral),
      };
    }

    const reading = this.estimator.update(fitted, COEBIS_V2_FIT_RATE, stepSeconds);
    if (!reading) return null;
    return {
      ...common,
      status: "available",
      index: this.tune ? Math.round(applyTune(this.tune, reading.index)) : reading.index,
      instant: this.tune ? applyTune(this.tune, reading.instant) : reading.instant,
      suppressionRatio: reading.suppressionRatio,
      terms: reading.terms,
      drivers: reading.drivers,
      withheldReason: null,
      researchFeatures: relativeFeatures(reading.terms),
    };
  }
}
