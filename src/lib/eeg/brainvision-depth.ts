/**
 * Condition-referenced depth for OpenNeuro ds005620 (BrainVision).
 *
 * ds005620 publishes no bedside depth index either. What it publishes is the
 * recording condition in the filename: `awake` before any drug, `sed` and
 * `sed2` during a target-controlled propofol sedation. Each recording is one
 * steady state, so the whole file carries a single coarse reference.
 *
 * The same honesty rules as the ds004541 event route apply, and one more:
 * because the reference is a *condition* rather than a timed clinical event,
 * the sedated anchor carries a wider spread than the awake one — "sedated"
 * covers a broad band of the scale.
 */

import type { PathologyAnnotation } from "./pathology-datasets";
import type { ReplayFrame } from "./replay";
import { lineageKey, type DataLineage } from "./model-lineage";
import { buildEventDepthPoints, type EventDepthResult } from "./openneuro-depth";
import { OPENNEURO_DS005620_SOURCE } from "./openneuro-brainvision";

export const BRAINVISION_DEPTH_REFERENCE_KIND = "condition-state";
/** Device id the ds005620 research cap is filed under for paired readings. */
export const BRAINVISION_DEPTH_DEVICE_ID = "openneuro-ds005620";
export const BRAINVISION_DEPTH_SOURCE = OPENNEURO_DS005620_SOURCE;

/**
 * Reference index per published condition, on the BIS/COEBIS 0–100 scale.
 * Awake matches the ds004541 anchor. Sedation targeted at responsiveness to
 * name (a light, arousable plane) conventionally sits around 75, with a wide
 * spread because the protocol never fixes a single depth.
 */
export const CONDITION_DEPTH_ANCHORS: Record<string, { depth: number; sigma: number }> = {
  awake: { depth: 93, sigma: 6 },
  sedated: { depth: 75, sigma: 12 },
};

export function brainVisionDepthLineage(channel: string, sampleRate: number): DataLineage {
  return {
    deviceId: BRAINVISION_DEPTH_DEVICE_ID,
    deviceLabel: "OpenNeuro ds005620 research cap (frontal derivation)",
    transport: "ingest",
    channels: [/[13579]\s*$/.test(channel.trim()) ? "AF7" : "AF8"],
    sampleRate: Math.round(sampleRate),
  };
}

export function brainVisionDepthLineageKey(channel: string, sampleRate: number): string {
  return lineageKey(brainVisionDepthLineage(channel, sampleRate));
}

/**
 * Pair replayed app indices with the condition the recording was made under.
 * Only the decoded span is used, and a short guard is dropped at each end so a
 * settling filter or an amplifier transient never reaches the fit.
 */
export function buildConditionDepthPoints(
  frames: ReplayFrame[],
  meta: { caseRef: string; channel: string; state: string | null; durationSeconds: number },
): EventDepthResult {
  const empty: EventDepthResult = {
    points: [],
    states: {},
    rejected: { transition: 0, shortInterval: 0, noIndex: 0, guarded: 0 },
  };
  if (!meta.state || !CONDITION_DEPTH_ANCHORS[meta.state]) {
    return { ...empty, rejected: { ...empty.rejected, transition: 1 } };
  }
  const interval: PathologyAnnotation = {
    channel: meta.channel,
    label: meta.state,
    startSeconds: 0,
    stopSeconds: meta.durationSeconds,
    confidence: null,
  };

  return buildEventDepthPoints(
    frames,
    [interval],
    { caseRef: meta.caseRef, channel: meta.channel, refPrefix: BRAINVISION_DEPTH_SOURCE },
    {
      anchors: CONDITION_DEPTH_ANCHORS,
      strideSeconds: 5,
      guardSeconds: 10,
      minIntervalSeconds: 40,
    },
  );
}
