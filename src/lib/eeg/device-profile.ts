/**
 * Device profiles.
 *
 * The analysis pipeline used to assume one specific headband: four electrodes
 * (TP9/AF7/AF8/TP10), two per hemisphere, 256 Hz. That union was hardcoded in
 * the monitor hook, the completeness tallies and every channel picker, so any
 * other amplifier — a two-channel frontal headset, a single-channel consumer
 * band, a CSV export from a clinical amplifier — either could not be used or
 * silently read as four electrodes with two of them flat.
 *
 * A device profile states, in one place, what a given source actually
 * provides: which of the canonical analysis positions are populated, how they
 * group by hemisphere, the native sample rate, and how the device labels each
 * position on its own casing. Everything downstream reads the profile instead
 * of a fixed list, so an absent electrode is treated as absent rather than as
 * a failed one, and the clinical caveats of a reduced montage are stated
 * explicitly rather than being left for the clinician to infer.
 *
 * The analysis rate itself stays fixed at ANALYSIS_SAMPLE_RATE: generic
 * sources resample onto it (see ingest.ts), so only the device-facing rate
 * varies between profiles.
 */

import { MUSE_SAMPLE_RATE } from "@/lib/eeg/dsp";

/**
 * Canonical analysis positions. Named after the Muse electrode set for
 * continuity with existing recordings, but treated as generic
 * left/right × temporal/frontal slots that any device can be mapped onto.
 * This is the single definition of the set; muse.ts re-exports it under its
 * historical names.
 */
export const ANALYSIS_CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;

export type AnalysisChannel = (typeof ANALYSIS_CHANNELS)[number];

/** Rate every metric is computed at; sources are resampled onto it. */
export const ANALYSIS_SAMPLE_RATE = MUSE_SAMPLE_RATE;

export type Hemisphere = "left" | "right";

/** Fixed anatomical side of each canonical position. */
export const CHANNEL_SIDE: Record<AnalysisChannel, Hemisphere> = {
  TP9: "left",
  AF7: "left",
  AF8: "right",
  TP10: "right",
};

/** Standard 10-20 equivalents, shown so a montage can be checked at a glance. */
export const CHANNEL_REGION: Record<AnalysisChannel, string> = {
  TP9: "left temporal",
  AF7: "left frontal",
  AF8: "right frontal",
  TP10: "right temporal",
};

export interface DeviceProfile {
  /** Stable id stored with the recording. */
  id: string;
  label: string;
  /** How the samples reach the app. */
  transport: "ble" | "ingest" | "simulated";
  /** Populated analysis positions, in acquisition order. */
  channels: AnalysisChannel[];
  /** Native device rate in Hz, before resampling onto the analysis rate. */
  sampleRate: number;
  /** The device's own name for each position (e.g. "Fp1" for AF7). */
  sourceLabels: Partial<Record<AnalysisChannel, string>>;
  /** Free-text note about montage limitations, shown in the UI. */
  note: string;
  /**
   * Samples arrive in real microvolts. False when the ADC scale is unknown and
   * the stream is auto-gained, which makes absolute µV thresholds relative.
   * Absent means calibrated, for continuity with existing recordings.
   */
  calibratedAmplitude?: boolean;
  capabilities: {
    battery: boolean;
    reconnect: boolean;
    /** Device reports per-electrode contact independently of the signal. */
    contactSensing: boolean;
  };
}

function profile(p: DeviceProfile): DeviceProfile {
  return p;
}

export const MUSE_2_PROFILE = profile({
  id: "muse-2",
  label: "Muse 2 / Muse S",
  transport: "ble",
  channels: ["TP9", "AF7", "AF8", "TP10"],
  sampleRate: 256,
  sourceLabels: {},
  note: "Full four-electrode montage — every metric behaves as designed.",
  capabilities: { battery: true, reconnect: true, contactSensing: false },
});

export const SIMULATED_PROFILE = profile({
  id: "simulated",
  label: "Demo signal",
  transport: "simulated",
  channels: ["TP9", "AF7", "AF8", "TP10"],
  sampleRate: 256,
  sourceLabels: {},
  note: "Synthetic four-electrode signal for training and demonstration — not patient data.",
  capabilities: { battery: false, reconnect: false, contactSensing: false },
});

/**
 * FocusCalm exposes a single frontal differential channel. It is mapped onto
 * one frontal position: the montage is unilateral by construction, so
 * hemispheric comparison and bilateral coherence are unavailable.
 */
export const FOCUSCALM_PROFILE = profile({
  id: "focuscalm",
  label: "FocusCalm (single frontal channel)",
  transport: "ingest",
  channels: ["AF7"],
  sampleRate: 250,
  sourceLabels: { AF7: "Fp1–Fp2" },
  note: "One frontal channel only. Suppression ratio and spectral edge remain interpretable; hemispheric asymmetry, side preference and bilateral coherence are not available, and COEBIS runs without its bilateral adjunct.",
  capabilities: { battery: true, reconnect: false, contactSensing: false },
});

/** Two-channel frontal montage, the common shape of clinical BIS-style strips. */
export const FRONTAL_PAIR_PROFILE = profile({
  id: "frontal-pair",
  label: "Bilateral frontal pair",
  transport: "ingest",
  channels: ["AF7", "AF8"],
  sampleRate: 256,
  sourceLabels: { AF7: "Fp1", AF8: "Fp2" },
  note: "Two frontal electrodes, one per side. Hemispheric comparison works; per-side quality gating has only one electrode to fall back on.",
  capabilities: { battery: false, reconnect: false, contactSensing: false },
});

export const DEVICE_PROFILES: DeviceProfile[] = [
  MUSE_2_PROFILE,
  FRONTAL_PAIR_PROFILE,
  FOCUSCALM_PROFILE,
  SIMULATED_PROFILE,
];

export function deviceProfileById(id: string): DeviceProfile | undefined {
  return DEVICE_PROFILES.find((p) => p.id === id);
}

/* ------------------------------------------------------------------ */
/* Derived montage facts                                               */
/* ------------------------------------------------------------------ */

/** Populated positions on one side, in acquisition order. */
export function hemisphereChannels(p: DeviceProfile, side: Hemisphere): AnalysisChannel[] {
  return p.channels.filter((c) => CHANNEL_SIDE[c] === side);
}

/** True when both hemispheres have at least one electrode. */
export function isBilateral(p: DeviceProfile): boolean {
  return hemisphereChannels(p, "left").length > 0 && hemisphereChannels(p, "right").length > 0;
}

/**
 * Channels grouped in twos. Two real spectra come out of one complex FFT, so
 * the quality pass rates electrodes in pairs; an odd montage leaves a single
 * trailing channel, which the caller handles with a plain real FFT.
 */
export function channelPairs(p: DeviceProfile): [AnalysisChannel, AnalysisChannel | null][] {
  const out: [AnalysisChannel, AnalysisChannel | null][] = [];
  for (let i = 0; i < p.channels.length; i += 2) {
    out.push([p.channels[i]!, p.channels[i + 1] ?? null]);
  }
  return out;
}

/** Display name for a position: the device's own label when it has one. */
export function channelLabel(p: DeviceProfile, channel: AnalysisChannel): string {
  const source = p.sourceLabels[channel];
  return source ? `${channel} (${source})` : channel;
}

/** Clinical consequences of the montage, in plain language. */
export function describeDeviceProfile(p: DeviceProfile): {
  bilateral: boolean;
  channelCount: number;
  missing: AnalysisChannel[];
  limitations: string[];
} {
  const missing = ANALYSIS_CHANNELS.filter((c) => !p.channels.includes(c));
  const limitations: string[] = [];
  if (!isBilateral(p)) {
    limitations.push(
      "Unilateral montage — hemispheric asymmetry, side preference and bilateral coherence are unavailable.",
    );
  }
  if (p.channels.length < 4) {
    limitations.push(
      `${p.channels.length} of 4 analysis positions populated — quality gating has fewer electrodes to fall back on.`,
    );
  }
  if (p.sampleRate < ANALYSIS_SAMPLE_RATE) {
    limitations.push(
      `Device samples at ${p.sampleRate} Hz and is upsampled to ${ANALYSIS_SAMPLE_RATE} Hz — no information is added above ${Math.floor(p.sampleRate / 2)} Hz, so the EMG band is partly out of reach.`,
    );
  }
  return { bilateral: isBilateral(p), channelCount: p.channels.length, missing, limitations };
}

/** Builds a profile for a generic source from its resolved channel mapping. */
export function profileFromChannelMap(options: {
  id?: string;
  label: string;
  sampleRate: number;
  /** Analysis position → the source column feeding it. */
  map: Partial<Record<AnalysisChannel, string | null>>;
  transport?: DeviceProfile["transport"];
}): DeviceProfile {
  const channels = ANALYSIS_CHANNELS.filter((c) => options.map[c]);
  const sourceLabels: Partial<Record<AnalysisChannel, string>> = {};
  for (const c of channels) {
    const column = options.map[c];
    if (column) sourceLabels[c] = column;
  }
  const base: DeviceProfile = {
    id: options.id ?? "ingest",
    label: options.label,
    transport: options.transport ?? "ingest",
    channels: [...channels],
    sampleRate: options.sampleRate,
    sourceLabels,
    note: "",
    capabilities: { battery: false, reconnect: false, contactSensing: false },
  };
  const described = describeDeviceProfile(base);
  base.note = described.limitations.length
    ? described.limitations.join(" ")
    : "Full four-electrode montage — all metrics behave as designed.";
  return base;
}

/* ------------------------------------------------------------------ */
/* Active profile store                                                */
/* ------------------------------------------------------------------ */

let active: DeviceProfile = MUSE_2_PROFILE;
const listeners = new Set<() => void>();

/** The profile of the source currently feeding the analysis. */
export function getActiveDeviceProfile(): DeviceProfile {
  return active;
}

export function setActiveDeviceProfile(p: DeviceProfile) {
  if (p === active) return;
  active = p;
  for (const l of listeners) l();
}

export function subscribeDeviceProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
