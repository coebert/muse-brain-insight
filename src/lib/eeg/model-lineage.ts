/**
 * Model lineage — which acquisition setup a fitted model is entitled to run on.
 *
 * COEBIS coefficients and the seizure detector's thresholds are not universal
 * constants: they were fitted, or validated, against a particular montage at a
 * particular sample rate. Run the same numbers on a single-channel consumer
 * band and the output still looks like a BIS-scale index, but nothing behind
 * it holds — the bilateral adjunct has no second hemisphere, the temporal
 * electrodes that carry ictal rhythms are absent, and the EMG band the
 * artefact rejection depends on may be above the device's Nyquist limit.
 *
 * A *lineage* is a compact statement of that setup: device, populated analysis
 * positions and native sample rate. Every paired reading is filed with the
 * lineage it came from; every fitted model records the lineage of the data it
 * learned from; and before either a model or a validated threshold is applied,
 * the current lineage is compared against it. A mismatch does not silently
 * degrade the number — it downgrades it to provisional or withholds it, with
 * the reason stated.
 */

import {
  ANALYSIS_CHANNELS,
  ANALYSIS_SAMPLE_RATE,
  CHANNEL_SIDE,
  isBilateral,
  type AnalysisChannel,
  type DeviceProfile,
} from "./device-profile";

/** The acquisition setup a model was fitted on, or is being asked to run on. */
export interface DataLineage {
  /** Device profile id, e.g. "muse-2". */
  deviceId: string;
  deviceLabel: string;
  transport: DeviceProfile["transport"];
  /** Populated analysis positions, canonical order. */
  channels: AnalysisChannel[];
  /** Native device rate in Hz, before resampling onto the analysis rate. */
  sampleRate: number;
}

/** Below this native rate the 45 Hz analysis band cannot be reconstructed. */
export const MIN_USABLE_SAMPLE_RATE = 128;
/** Rate at which the detector thresholds were validated. */
export const VALIDATION_SAMPLE_RATE = ANALYSIS_SAMPLE_RATE;

export function lineageFromProfile(p: DeviceProfile): DataLineage {
  return {
    deviceId: p.id,
    deviceLabel: p.label,
    transport: p.transport,
    channels: ANALYSIS_CHANNELS.filter((c) => p.channels.includes(c)),
    sampleRate: p.sampleRate,
  };
}

/**
 * Stable key for grouping and storage. Deliberately excludes the free-text
 * label so a renamed CSV does not fork the lineage.
 */
export function lineageKey(l: DataLineage): string {
  const channels = ANALYSIS_CHANNELS.filter((c) => l.channels.includes(c)).join("-") || "none";
  return `${l.deviceId}|${channels}|${Math.round(l.sampleRate)}`;
}

/** Reads a stored key back into the parts that gate behaviour. */
export function parseLineageKey(key: string): DataLineage | null {
  const parts = key.split("|");
  if (parts.length !== 3) return null;
  const [deviceId, channelPart, ratePart] = parts as [string, string, string];
  const rate = Number(ratePart);
  if (!deviceId || !Number.isFinite(rate)) return null;
  const channels =
    channelPart === "none"
      ? []
      : channelPart
          .split("-")
          .filter((c): c is AnalysisChannel =>
            (ANALYSIS_CHANNELS as readonly string[]).includes(c),
          );
  return {
    deviceId,
    deviceLabel: deviceId,
    transport: deviceId === "muse-2" ? "ble" : "ingest",
    channels: ANALYSIS_CHANNELS.filter((c) => channels.includes(c)),
    sampleRate: rate,
  };
}

export function describeLineage(l: DataLineage): string {
  const channels = l.channels.length ? l.channels.join(", ") : "no electrodes";
  return `${l.deviceLabel} · ${channels} @ ${Math.round(l.sampleRate)} Hz`;
}

function hasSide(channels: AnalysisChannel[], side: "left" | "right"): boolean {
  return channels.some((c) => CHANNEL_SIDE[c] === side);
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

export type LineageMatch = "exact" | "compatible" | "reduced" | "incompatible";

export interface LineageComparison {
  match: LineageMatch;
  /** Positions the model was fitted on that this device does not provide. */
  missing: AnalysisChannel[];
  /** Positions this device adds, which the model simply ignores. */
  extra: AnalysisChannel[];
  reasons: string[];
  headline: string;
}

/**
 * Compare the setup a model came from against the setup now streaming.
 *
 * The generous cases are deliberate: resampling means a different but
 * adequately sampled device with the same electrode positions is genuinely the
 * same measurement, and extra electrodes cannot invalidate a model that never
 * looked at them. The strict cases are the ones that change the measurement:
 * losing a hemisphere, losing more than one fitted position, or sampling too
 * low for the analysis band.
 */
export function compareLineage(
  fitted: DataLineage | null | undefined,
  current: DataLineage,
): LineageComparison {
  if (!fitted) {
    return {
      match: "incompatible",
      missing: [],
      extra: [],
      reasons: ["The model does not record which device it was fitted on."],
      headline: "Calibration lineage unknown",
    };
  }

  const missing = fitted.channels.filter((c) => !current.channels.includes(c));
  const extra = current.channels.filter((c) => !fitted.channels.includes(c));
  const reasons: string[] = [];

  if (current.sampleRate < MIN_USABLE_SAMPLE_RATE) {
    reasons.push(
      `This device samples at ${Math.round(current.sampleRate)} Hz — below the ${MIN_USABLE_SAMPLE_RATE} Hz needed for the analysis band, so upsampling cannot recover it.`,
    );
    return {
      match: "incompatible",
      missing,
      extra,
      reasons,
      headline: "Sample rate too low for this model",
    };
  }

  if (current.channels.length === 0) {
    return {
      match: "incompatible",
      missing,
      extra,
      reasons: ["No analysis electrode is mapped on this device."],
      headline: "No usable montage",
    };
  }

  const lostSide =
    (hasSide(fitted.channels, "left") && !hasSide(current.channels, "left")) ||
    (hasSide(fitted.channels, "right") && !hasSide(current.channels, "right"));

  if (lostSide) {
    reasons.push(
      "The model was fitted on a bilateral montage; this device covers one hemisphere only, so its side-dependent terms have no input.",
    );
    return {
      match: "incompatible",
      missing,
      extra,
      reasons,
      headline: "Montage lost a hemisphere the model needs",
    };
  }

  if (missing.length > 1) {
    reasons.push(
      `${missing.length} of the ${fitted.channels.length} positions the model was fitted on are absent (${missing.join(", ")}).`,
    );
    return {
      match: "incompatible",
      missing,
      extra,
      reasons,
      headline: "Too much of the fitted montage is missing",
    };
  }

  if (missing.length === 1) {
    reasons.push(
      `${missing[0]} is absent on this device; the model runs on the remaining positions with wider uncertainty.`,
    );
    if (current.sampleRate < VALIDATION_SAMPLE_RATE) {
      reasons.push(
        `Native rate ${Math.round(current.sampleRate)} Hz is below the ${VALIDATION_SAMPLE_RATE} Hz the model was fitted at.`,
      );
    }
    return {
      match: "reduced",
      missing,
      extra,
      reasons,
      headline: "Running on a reduced montage",
    };
  }

  if (lineageKey(fitted) === lineageKey(current)) {
    return {
      match: "exact",
      missing,
      extra,
      reasons: ["Same device, montage and sample rate the model was fitted on."],
      headline: "Matches calibration lineage",
    };
  }

  if (fitted.deviceId !== current.deviceId) {
    reasons.push(
      `Fitted on ${fitted.deviceLabel}, running on ${current.deviceLabel}; the electrode positions match, so the fit transfers, but no paired readings confirm it on this hardware yet.`,
    );
  }
  if (Math.round(fitted.sampleRate) !== Math.round(current.sampleRate)) {
    reasons.push(
      `Fitted at ${Math.round(fitted.sampleRate)} Hz, running at ${Math.round(current.sampleRate)} Hz; both are resampled to ${ANALYSIS_SAMPLE_RATE} Hz before analysis.`,
    );
  }
  if (extra.length) {
    reasons.push(`${extra.join(", ")} is present but was not part of the fit, so it is ignored.`);
  }

  return {
    match: "compatible",
    missing,
    extra,
    reasons,
    headline: "Compatible montage, different hardware",
  };
}

/* ------------------------------------------------------------------ */
/* Model gate                                                          */
/* ------------------------------------------------------------------ */

export type GateMode = "run" | "provisional" | "blocked";

export interface LineageGate {
  mode: GateMode;
  /** Whether the value may be shown at all. */
  allowed: boolean;
  /** Shown, but must carry a caveat. */
  degraded: boolean;
  comparison: LineageComparison;
  headline: string;
  /** What the clinician should do about it. */
  action: string;
}

/**
 * Whether a fitted COEBIS model may drive the displayed index on the device
 * currently streaming.
 */
export function gateCoebisModel(
  fitted: DataLineage | null | undefined,
  current: DataLineage,
): LineageGate {
  const comparison = compareLineage(fitted, current);
  if (comparison.match === "exact") {
    return {
      mode: "run",
      allowed: true,
      degraded: false,
      comparison,
      headline: "COEBIS is running on the hardware it was calibrated on.",
      action: "No action needed.",
    };
  }
  if (comparison.match === "incompatible") {
    return {
      mode: "blocked",
      allowed: false,
      degraded: false,
      comparison,
      headline: `COEBIS is withheld: ${comparison.headline.toLowerCase()}.`,
      action:
        "The published open index is shown instead. Pair readings on this device to fit a model for it.",
    };
  }
  return {
    mode: "provisional",
    allowed: true,
    degraded: true,
    comparison,
    headline: `COEBIS is provisional on this device: ${comparison.headline.toLowerCase()}.`,
    action: "Enter paired commercial BIS readings on this device to confirm the correction here.",
  };
}

/* ------------------------------------------------------------------ */
/* Seizure detector gate                                               */
/* ------------------------------------------------------------------ */

/**
 * The setup the seizure vignettes were validated against: full four-electrode
 * montage at the analysis rate. Temporal coverage matters most — the rhythms
 * the detector scores are largely temporal in origin.
 */
export const SEIZURE_VALIDATION_LINEAGE: DataLineage = {
  deviceId: "muse-2",
  deviceLabel: "Muse 2 / Muse S",
  transport: "ble",
  channels: [...ANALYSIS_CHANNELS],
  sampleRate: VALIDATION_SAMPLE_RATE,
};

export interface SeizureGate {
  mode: GateMode;
  allowed: boolean;
  /** Amount added to the score threshold to hold the false-alarm rate. */
  thresholdDelta: number;
  /** Extra consecutive epochs required before alerting. */
  extraEpochs: number;
  reasons: string[];
  headline: string;
  action: string;
}

/**
 * Whether the validated seizure thresholds may be used on this montage, and
 * how they must be stiffened if the montage is thinner than the validated one.
 *
 * The specificity figures published in the app come from vignettes scored on
 * the full montage. On a reduced montage the same threshold sees fewer
 * independent looks at the same rhythm, so the false-alarm rate rises unless
 * the bar is raised; on a single channel there is nothing to corroborate a
 * rhythm against at all, and the detector is withheld rather than guessed.
 */
export function gateSeizureDetector(profile: DeviceProfile): SeizureGate {
  const current = lineageFromProfile(profile);
  const temporal = current.channels.filter((c) => c === "TP9" || c === "TP10");
  const reasons: string[] = [];

  if (current.sampleRate < MIN_USABLE_SAMPLE_RATE) {
    return {
      mode: "blocked",
      allowed: false,
      thresholdDelta: 0,
      extraEpochs: 0,
      reasons: [
        `${current.deviceLabel} samples at ${Math.round(current.sampleRate)} Hz; the detector's artefact and EMG rejection needs at least ${MIN_USABLE_SAMPLE_RATE} Hz.`,
      ],
      headline: "Seizure detection is off on this device",
      action: "Use a device sampling at 128 Hz or above for ictal surveillance.",
    };
  }

  if (!isBilateral(profile) || current.channels.length < 2) {
    return {
      mode: "blocked",
      allowed: false,
      thresholdDelta: 0,
      extraEpochs: 0,
      reasons: [
        `${current.deviceLabel} provides ${current.channels.length === 1 ? "a single channel" : "one hemisphere only"}; a rhythm cannot be corroborated against another derivation, and the validated false-alarm rate does not transfer.`,
      ],
      headline: "Seizure detection is off on this montage",
      action:
        "Ictal surveillance needs at least one electrode per hemisphere. Raw traces remain available for visual review.",
    };
  }

  if (temporal.length === 0) {
    reasons.push(
      "No temporal electrode: frontal-only montages under-read temporal-onset rhythms, so sensitivity is lower than the published validation.",
    );
  } else if (temporal.length === 1) {
    reasons.push(
      `Only ${temporal[0]} covers the temporal regions, so onset on the other side is seen indirectly.`,
    );
  }
  if (current.channels.length < SEIZURE_VALIDATION_LINEAGE.channels.length) {
    reasons.push(
      `${current.channels.length} of ${SEIZURE_VALIDATION_LINEAGE.channels.length} validated positions are populated, so the threshold is raised to hold the false-alarm rate.`,
    );
  }
  if (current.sampleRate < VALIDATION_SAMPLE_RATE) {
    reasons.push(
      `Native rate ${Math.round(current.sampleRate)} Hz is below the ${VALIDATION_SAMPLE_RATE} Hz used for validation.`,
    );
  }

  if (!reasons.length) {
    return {
      mode: "run",
      allowed: true,
      thresholdDelta: 0,
      extraEpochs: 0,
      reasons: ["Montage and sample rate match the validated configuration."],
      headline: "Seizure detection is running at validated thresholds",
      action: "No action needed.",
    };
  }

  // One missing position costs one corroborating look; no temporal coverage
  // costs the derivation the detector relies on most.
  const missing = SEIZURE_VALIDATION_LINEAGE.channels.length - current.channels.length;
  const thresholdDelta = Number(
    (0.04 * Math.max(0, missing) + (temporal.length === 0 ? 0.06 : 0)).toFixed(2),
  );
  return {
    mode: "provisional",
    allowed: true,
    thresholdDelta,
    extraEpochs: temporal.length === 0 ? 1 : 0,
    reasons,
    headline: "Seizure detection is running outside its validated montage",
    action:
      "Treat alerts and the published false-alarm rate as indicative; confirm on the raw traces.",
  };
}

/** Apply a seizure gate to detector settings. */
export function applySeizureGate<
  T extends { seizureThreshold: number; seizureEpochs: number },
>(settings: T, gate: SeizureGate): T {
  if (gate.mode === "run") return settings;
  if (!gate.allowed) {
    // Threshold above the score ceiling: the detector can never fire.
    return { ...settings, seizureThreshold: 2, seizureEpochs: settings.seizureEpochs };
  }
  return {
    ...settings,
    seizureThreshold: Math.min(0.95, settings.seizureThreshold + gate.thresholdDelta),
    seizureEpochs: settings.seizureEpochs + gate.extraEpochs,
  };
}

/* ------------------------------------------------------------------ */
/* Training-set lineage summary                                        */
/* ------------------------------------------------------------------ */

export interface LineageTally {
  key: string;
  lineage: DataLineage | null;
  n: number;
  /** Cases contributing to this lineage. */
  cases: number;
}

export interface LineageSummary {
  tallies: LineageTally[];
  /** Lineage with the most readings, if any. */
  dominant: LineageTally | null;
  /** Readings filed before lineage was recorded. */
  unlabelled: number;
  /** More than one lineage contributed readings. */
  mixed: boolean;
  /** Share of labelled readings coming from the dominant lineage, 0–1. */
  dominantShare: number;
  note: string;
}

/**
 * How many acquisition setups the pooled training data actually spans.
 *
 * A model fitted across mixed hardware without any device term is fitting the
 * average of two different measurements, which is why this is surfaced as its
 * own sufficiency check rather than folded into the point count.
 */
export function summariseLineages(
  points: { lineageKey?: string | null; sessionId?: string | null }[],
): LineageSummary {
  const byKey = new Map<string, { n: number; cases: Set<string> }>();
  let unlabelled = 0;
  for (const p of points) {
    const key = p.lineageKey?.trim();
    if (!key) {
      unlabelled += 1;
      continue;
    }
    const entry = byKey.get(key) ?? { n: 0, cases: new Set<string>() };
    entry.n += 1;
    if (p.sessionId) entry.cases.add(p.sessionId);
    byKey.set(key, entry);
  }
  const tallies: LineageTally[] = [...byKey.entries()]
    .map(([key, v]) => ({ key, lineage: parseLineageKey(key), n: v.n, cases: v.cases.size }))
    .sort((a, b) => b.n - a.n);
  const labelled = tallies.reduce((sum, t) => sum + t.n, 0);
  const dominant = tallies[0] ?? null;
  const dominantShare = labelled > 0 && dominant ? dominant.n / labelled : 0;
  const mixed = tallies.length > 1;
  const note = !labelled
    ? unlabelled
      ? `${unlabelled} reading${unlabelled === 1 ? "" : "s"} were filed before the device was recorded, so their lineage is unknown.`
      : "No paired readings yet."
    : mixed
      ? `Readings span ${tallies.length} acquisition setups; ${Math.round(dominantShare * 100)}% come from ${dominant ? describeLineage(dominant.lineage ?? parseLineageKey(dominant.key)!) : "one setup"}.`
      : `All ${labelled} labelled reading${labelled === 1 ? "" : "s"} come from ${dominant?.lineage ? describeLineage(dominant.lineage) : dominant?.key}.`;
  return { tallies, dominant, unlabelled, mixed, dominantShare, note };
}

/**
 * Readings a model for `target` may honestly be fitted on: the same lineage,
 * plus any lineage whose montage transfers to it.
 */
export function selectTrainingForLineage<T extends { lineageKey?: string | null }>(
  points: T[],
  target: DataLineage,
): { used: T[]; excluded: T[]; unlabelled: T[] } {
  const used: T[] = [];
  const excluded: T[] = [];
  const unlabelled: T[] = [];
  for (const p of points) {
    const key = p.lineageKey?.trim();
    if (!key) {
      // Historic readings predate lineage recording; they are kept, because
      // excluding them would discard the entire early training set.
      unlabelled.push(p);
      used.push(p);
      continue;
    }
    const parsed = parseLineageKey(key);
    const match = compareLineage(parsed, target).match;
    if (match === "incompatible") excluded.push(p);
    else used.push(p);
  }
  return { used, excluded, unlabelled };
}
