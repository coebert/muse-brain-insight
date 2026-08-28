/**
 * Device-adaptive tuning.
 *
 * A device profile says what a headset provides; this module turns that into
 * the concrete choices the running monitor should make. A Muse 2 with four
 * electrodes, 256 Hz and calibrated microvolts gets the full bilateral
 * presentation, the EMG band, absolute suppression thresholds and automatic
 * reconnection. A FocusCalm band — one frontal channel at 250 Hz, with an
 * unknown ADC scale unless the clinician supplies one — gets the combined DSA
 * (there is no second hemisphere to draw), a relative suppression caveat,
 * stiffened seizure persistence and a manual retry path.
 *
 * Every decision is derived from the profile rather than from a device name,
 * so a two-channel frontal strip or a CSV replay lands in the right place
 * without a new branch.
 */

import type { DsaView } from "@/lib/eeg/dsa-view-pref";

import {
  ANALYSIS_SAMPLE_RATE,
  isBilateral,
  type DeviceProfile,
} from "./device-profile";

export interface DeviceTuning {
  profileId: string;
  label: string;
  /** DSA layouts the montage can actually render. */
  dsaViews: DsaView[];
  /** Layout to open with on this device. */
  defaultDsaView: DsaView;
  /** Show the battery pill in the header. */
  showBattery: boolean;
  /** The source restores its own link after a dropout. */
  autoReconnect: boolean;
  /** Highest frequency the device can carry, after resampling. */
  usableCeilingHz: number;
  /** EMG discrimination needs energy above ~30 Hz to be real, not interpolated. */
  emgBandAvailable: boolean;
  /** Absolute µV thresholds (suppression) can be trusted. */
  absoluteAmplitude: boolean;
  /** Seizure persistence is raised because one channel cannot corroborate. */
  stiffenedSeizureGating: boolean;
  /** What the app has changed for this device, in clinician terms. */
  optimisations: string[];
  /** What the device cannot support, stated rather than silently degraded. */
  caveats: string[];
}

/** Nyquist of the device, capped by the analysis rate; nothing above is real. */
function ceilingHz(profile: DeviceProfile): number {
  const nyquist = Math.min(profile.sampleRate, ANALYSIS_SAMPLE_RATE) / 2;
  return Math.floor(nyquist);
}

/** Resolves the running configuration for a montage. */
export function deviceTuning(profile: DeviceProfile): DeviceTuning {
  const bilateral = isBilateral(profile);
  const ceiling = ceilingHz(profile);
  const emg = ceiling >= 45;
  const absolute = profile.calibratedAmplitude !== false;

  const dsaViews: DsaView[] = bilateral ? ["bilateral", "combined", "overlay"] : ["combined"];
  const optimisations: string[] = [];
  const caveats: string[] = [];

  if (bilateral) {
    optimisations.push(
      "Bilateral DSA, hemispheric asymmetry and side preference are active — both hemispheres are electroded.",
    );
  } else {
    optimisations.push(
      "Single combined DSA lane: the montage is unilateral, so the app draws one spectrogram instead of an empty second hemisphere.",
    );
    caveats.push(
      "No hemispheric comparison, side preference or bilateral coherence; COEBIS runs without its bilateral adjunct.",
    );
  }

  if (profile.channels.length >= 4) {
    optimisations.push(
      "Quality gating can drop a failing electrode and keep analysing on the remaining three.",
    );
  } else {
    caveats.push(
      `${profile.channels.length} of 4 analysis positions populated — a lost electrode stops analysis on that side rather than degrading it.`,
    );
  }

  if (emg) {
    optimisations.push(
      `Full band to ${ceiling} Hz: EMG rejection and the 45 Hz artefact filter work as designed.`,
    );
  } else {
    caveats.push(
      `Device carries information only to ${ceiling} Hz — EMG discrimination is partial, so frontalis activity may be read as fast EEG.`,
    );
  }

  if (absolute) {
    optimisations.push(
      "Amplitude is calibrated in microvolts: the absolute suppression threshold and burst-suppression ratio are quantitative.",
    );
  } else {
    caveats.push(
      "Amplitude is auto-gained (no µV-per-count supplied) — spectral shape, SEF95 and depth stay valid, but the absolute suppression threshold is relative and the suppression ratio is flagged as uncalibrated.",
    );
  }

  if (profile.capabilities.reconnect) {
    optimisations.push("Dropouts trigger automatic re-pairing; the case timeline keeps running.");
  } else {
    caveats.push(
      "This device does not re-pair itself — a dropout needs the Reconnect button, and the gap is marked in the record.",
    );
  }

  if (profile.sampleRate !== ANALYSIS_SAMPLE_RATE) {
    optimisations.push(
      `Stream is resampled from ${profile.sampleRate} Hz onto the ${ANALYSIS_SAMPLE_RATE} Hz analysis grid, so epochs stay aligned to the one-second tiles.`,
    );
  }

  return {
    profileId: profile.id,
    label: profile.label,
    dsaViews,
    defaultDsaView: bilateral ? "bilateral" : "combined",
    showBattery: profile.capabilities.battery,
    autoReconnect: profile.capabilities.reconnect,
    usableCeilingHz: ceiling,
    emgBandAvailable: emg,
    absoluteAmplitude: absolute,
    stiffenedSeizureGating: !bilateral,
    optimisations,
    caveats,
  };
}

/** Clamps a stored layout preference to one this device can render. */
export function resolveDsaView(tuning: DeviceTuning, requested: DsaView): DsaView {
  return tuning.dsaViews.includes(requested) ? requested : tuning.defaultDsaView;
}
