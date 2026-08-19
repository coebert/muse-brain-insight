/**
 * Runtime guard for detector configuration.
 *
 * Schema validation at the storage boundary is not enough: a config can be
 * well-formed and still belong to another acquisition setup, or carry legacy
 * threshold field names that silently read as undefined. This module is the
 * last check before COEBIS or the seizure detector runs on live data. It
 * either clears the detector, downgrades it to a warning, or blocks it, and
 * always says why in clinician-readable terms.
 */
import { getActiveDeviceProfile, type DeviceProfile } from "./device-profile";
import {
  parseCoebisModel,
  parseDetectorThresholds,
  type DetectorThresholdConfig,
} from "./model-config-schema";
import {
  gateSeizureDetector,
  lineageFromProfile,
  lineageKey,
  parseLineageKey,
  transferCompatibility,
  type SeizureGate,
} from "./model-lineage";

export type GuardStatus = "ok" | "warn" | "blocked";

export interface GuardResult {
  status: GuardStatus;
  /** Reasons the detector is blocked. Empty unless status is "blocked". */
  issues: string[];
  /** Non-fatal notes, e.g. a legacy field name that was migrated in place. */
  warnings: string[];
  headline: string;
}

export interface SeizureGuardResult extends GuardResult {
  /** Thresholds safe to hand to the analyzers, after schema and montage gating. */
  thresholds: DetectorThresholdConfig | null;
}

const THRESHOLD_KEYS = [
  "seizureThreshold",
  "seizureEpochs",
  "suppressionThresholdUv",
  "srWindowSeconds",
] as const;

function pickThresholdShape(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of THRESHOLD_KEYS) if (k in settings) out[k] = settings[k];
  // Legacy names are passed through so the parser can report the rename.
  for (const k of ["seizureScoreThreshold", "seizureMinEpochs", "suppressionUv", "srWindow"]) {
    if (k in settings) out[k] = settings[k];
  }
  return out;
}

/**
 * Validate the threshold metadata about to drive seizure detection on the
 * live montage. Legacy field names are migrated in place and reported; a
 * shape that cannot be repaired blocks alerting rather than running the
 * detector on defaults nobody validated.
 */
export function guardSeizureRuntime(
  settings: Record<string, unknown>,
  opts: { profile?: DeviceProfile; gate?: SeizureGate } = {},
): SeizureGuardResult {
  const profile = opts.profile ?? getActiveDeviceProfile();
  const gate = opts.gate ?? gateSeizureDetector(profile);
  const parsed = parseDetectorThresholds(pickThresholdShape(settings), { migrate: true });

  if (!parsed.ok) {
    return {
      status: "blocked",
      issues: parsed.issues,
      warnings: [],
      headline:
        "Seizure alerting is held off: the stored detector thresholds do not match the current schema.",
      thresholds: null,
    };
  }

  const warnings = [...parsed.warnings];
  if (!gate.allowed) {
    return {
      status: "blocked",
      issues: gate.reasons,
      warnings,
      headline: gate.headline,
      thresholds: parsed.value,
    };
  }
  if (gate.mode === "provisional" || warnings.length) {
    return {
      status: "warn",
      issues: [],
      warnings: [...warnings, ...gate.reasons],
      headline:
        gate.mode === "provisional"
          ? gate.headline
          : "Seizure thresholds ran after a legacy field name was migrated — refit or re-save this config.",
      thresholds: parsed.value,
    };
  }
  return {
    status: "ok",
    issues: [],
    warnings,
    headline: "Validated seizure thresholds match this acquisition setup.",
    thresholds: parsed.value,
  };
}

/**
 * Validate a stored COEBIS alignment model before it is applied to a live
 * depth index. A model whose recorded lineage cannot transfer to the montage
 * now streaming is blocked; the published open index is used instead.
 */
export function guardCoebisRuntime(
  model: unknown,
  opts: { profile?: DeviceProfile } = {},
): GuardResult {
  const profile = opts.profile ?? getActiveDeviceProfile();
  const current = lineageFromProfile(profile);

  if (model == null) {
    return {
      status: "warn",
      issues: [],
      warnings: ["No fitted COEBIS model for this setup — the open index is shown unaligned."],
      headline: "No COEBIS model applies to this acquisition setup.",
    };
  }

  const parsed = parseCoebisModel(model);
  if (!parsed.ok) {
    return {
      status: "blocked",
      issues: parsed.issues,
      warnings: [],
      headline:
        "COEBIS alignment is held off: the stored model does not match the current schema.",
    };
  }

  const key = parsed.value.lineageKey;
  if (!key) {
    return {
      status: "warn",
      issues: [],
      warnings: ["The stored model records no acquisition setup, so transfer cannot be checked."],
      headline: "COEBIS is running provisionally on an unlabelled model.",
    };
  }

  const modelLineage = parseLineageKey(key);
  if (!modelLineage) {
    return {
      status: "blocked",
      issues: [`model lineage "${key}" cannot be read`],
      warnings: [],
      headline: "COEBIS alignment is held off: the model's acquisition setup is unreadable.",
    };
  }

  if (key === lineageKey(current)) {
    return {
      status: "ok",
      issues: [],
      warnings: [],
      headline: "COEBIS model was fitted on this exact acquisition setup.",
    };
  }

  const transfer = transferCompatibility(modelLineage, current);
  if (!transfer.compatible) {
    return {
      status: "blocked",
      issues: transfer.reasons,
      warnings: [],
      headline: "COEBIS alignment is held off: the model was fitted on an incompatible setup.",
    };
  }
  return {
    status: "warn",
    issues: [],
    warnings: transfer.reasons,
    headline: "COEBIS model transfers to this setup, but was fitted on a different one.",
  };
}
