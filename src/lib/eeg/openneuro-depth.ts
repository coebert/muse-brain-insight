/**
 * Event-referenced depth for OpenNeuro ds004541.
 *
 * ds004541 publishes no bedside depth index. What it does publish is a
 * protocol-timed events file: baseline, induction, loss of consciousness (LOC)
 * and return of consciousness (ROC). Those markers bracket states whose depth
 * is known categorically — awake before induction, anaesthetised between LOC
 * and ROC, awake again after ROC — even though the exact index is not.
 *
 * This module turns those states into a *coarse* depth reference so the
 * recording can contribute to a fit. Three honesty rules are enforced here
 * rather than left to the caller:
 *
 *  1. Only the two stable states are used. Induction and emergence are
 *     transitions: depth is changing quickly and any single reference value
 *     would be wrong for most of the interval.
 *  2. A guard band is dropped at each end of an interval, so a reading is only
 *     taken once the state has settled.
 *  3. The reference is labelled `event-state`, carries a wide uncertainty and
 *     never claims to be a commercial monitor reading. It belongs to its own
 *     acquisition lineage and cannot reach a device-specific COEBIS fit.
 */

import type { PathologyAnnotation } from "./pathology-datasets";
import type { ReplayFrame } from "./replay";
import { lineageKey, type DataLineage } from "./model-lineage";

export const OPENNEURO_DEPTH_REFERENCE_KIND = "event-state";
/** Device id the ds004541 clinical cap is filed under for paired readings. */
export const OPENNEURO_DEPTH_DEVICE_ID = "openneuro-ds004541";

/**
 * Reference index for each stable state, on the BIS/COEBIS 0–100 scale.
 * Values are the conventional clinical anchors: an awake, conversant patient
 * sits in the low-to-mid nineties, and maintenance general anaesthesia is
 * targeted at 40–60, whose midpoint is 50. `sigma` is the honest spread of the
 * anchor, and is stored so the fit can weight these readings down.
 */
export const EVENT_DEPTH_ANCHORS: Record<string, { depth: number; sigma: number }> = {
  awake: { depth: 93, sigma: 6 },
  anaesthetised: { depth: 50, sigma: 10 },
};

export interface EventDepthOptions {
  /** One retained reading per this many seconds of recording. */
  strideSeconds?: number;
  /** Seconds dropped at each end of an interval while the state settles. */
  guardSeconds?: number;
  /** Intervals shorter than this contribute nothing. */
  minIntervalSeconds?: number;
}

export interface EventDepthPoint {
  atSeconds: number;
  /** Reference index implied by the published state. */
  reference: number;
  referenceSigma: number;
  state: string;
  appIndex: number;
  appSef: number | null;
  appSr: number | null;
  reliable: boolean;
  externalRef: string;
}

export interface EventDepthResult {
  points: EventDepthPoint[];
  states: Record<string, number>;
  rejected: { transition: number; shortInterval: number; noIndex: number; guarded: number };
}

/**
 * The clinical cap's frontal electrodes occupy the app's forehead analysis
 * positions: odd labels (AF3, Fp1, F7) are left, even labels right. The device
 * id keeps the lineage separate regardless, so this mapping only records which
 * hemisphere the derivation came from.
 */
export function openNeuroAnalysisChannel(channel: string): "AF7" | "AF8" {
  return /[13579]\s*$/.test(channel.trim()) ? "AF7" : "AF8";
}

export function openNeuroDepthLineage(channel: string, sampleRate: number): DataLineage {
  return {
    deviceId: OPENNEURO_DEPTH_DEVICE_ID,
    deviceLabel: "OpenNeuro ds004541 clinical cap (frontal derivation)",
    transport: "ingest",
    channels: [openNeuroAnalysisChannel(channel)],
    sampleRate: Math.round(sampleRate),
  };
}

export function openNeuroDepthLineageKey(channel: string, sampleRate: number): string {
  return lineageKey(openNeuroDepthLineage(channel, sampleRate));
}

/**
 * Pair replayed app indices with the state the published events say the
 * patient was in at that second.
 */
export function buildEventDepthPoints(
  frames: ReplayFrame[],
  intervals: PathologyAnnotation[],
  meta: { caseRef: string; channel: string },
  options: EventDepthOptions = {},
): EventDepthResult {
  const stride = Math.max(1, options.strideSeconds ?? 10);
  const guard = Math.max(0, options.guardSeconds ?? 60);
  const minInterval = Math.max(guard * 2 + stride, options.minIntervalSeconds ?? 180);
  const rejected = { transition: 0, shortInterval: 0, noIndex: 0, guarded: 0 };
  const states: Record<string, number> = {};

  const usable = intervals.filter((iv) => {
    const anchor = EVENT_DEPTH_ANCHORS[iv.label ?? ""];
    if (!anchor) {
      rejected.transition++;
      return false;
    }
    if (iv.stopSeconds - iv.startSeconds < minInterval) {
      rejected.shortInterval++;
      return false;
    }
    return true;
  });

  const points: EventDepthPoint[] = [];
  for (const iv of usable) {
    const anchor = EVENT_DEPTH_ANCHORS[iv.label!]!;
    const from = iv.startSeconds + guard;
    const to = iv.stopSeconds - guard;
    let taken = -Infinity;
    for (const frame of frames) {
      if (frame.t < iv.startSeconds || frame.t > iv.stopSeconds) continue;
      if (frame.t < from || frame.t > to) {
        rejected.guarded++;
        continue;
      }
      if (frame.t - taken < stride) continue;
      if (frame.appIndex == null || !Number.isFinite(frame.appIndex)) {
        rejected.noIndex++;
        continue;
      }
      taken = frame.t;
      const at = Math.round(frame.t * 10) / 10;
      points.push({
        atSeconds: at,
        reference: anchor.depth,
        referenceSigma: anchor.sigma,
        state: iv.label!,
        appIndex: Number(frame.appIndex.toFixed(1)),
        appSef: Number.isFinite(frame.sef95) ? Number(frame.sef95.toFixed(2)) : null,
        appSr: Number.isFinite(frame.suppressionRatio)
          ? Number(frame.suppressionRatio.toFixed(1))
          : null,
        reliable: true,
        externalRef: `openneuro-ds004541:${meta.caseRef}:${meta.channel}:${at.toFixed(1)}`,
      });
      states[iv.label!] = (states[iv.label!] ?? 0) + 1;
    }
  }

  points.sort((a, b) => a.atSeconds - b.atSeconds);
  return { points, states, rejected };
}
