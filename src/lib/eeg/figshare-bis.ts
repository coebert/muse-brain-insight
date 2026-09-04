/**
 * figshare "EEG and BIS raw data" (Ma, record 5589841, CC-BY 4.0) — 24 surgical
 * cases published as one MATLAB v7.3 file each, holding a raw frontal EEG trace
 * and the BIS index the bedside monitor reported over the same recording.
 *
 * Like the VitalDB waveform import, this is a *paired* source: because the
 * signal itself is published we can replay it through the app's own estimator
 * and put the app index next to the commercial monitor's BIS for the same
 * moment. That pair is what a refit can be graded on; a BIS trend alone cannot.
 *
 * Two things the file does not state and this module therefore derives rather
 * than assumes silently:
 *
 *  - the BIS cadence. BIS monitors export one index per 5 s, and every case in
 *    the record has ~625 EEG samples per BIS value, which is consistent with
 *    5 s at 125 Hz and with nothing else plausible. The cadence is taken as 5 s
 *    and the implied sample rate is checked against 125 Hz; a case that lands
 *    outside tolerance is rejected instead of being replayed at a wrong rate,
 *    which would move every spectral feature.
 *  - the electrode derivation. It is the BIS sensor's frontal channel, so it is
 *    filed at the app's AF7 position under its own acquisition lineage. It is
 *    never merged with Muse or VitalDB readings.
 */

import { lineageKey, type DataLineage } from "./model-lineage";
import { replayRawEeg } from "./replay";

/** Source id every reading from this record carries. */
export const FIGSHARE_BIS_SOURCE = "figshare:5589841";
/** Device id the record's bedside frontal montage is filed under. */
export const FIGSHARE_BIS_DEVICE_ID = "figshare-ma-bis";
/** Published BIS export cadence, in seconds. */
export const FIGSHARE_BIS_INTERVAL_SECONDS = 5;
/** Sample rate the cadence implies, and the only rate accepted. */
export const FIGSHARE_BIS_SAMPLE_RATE = 125;
/** How far the derived rate may sit from that before the case is rejected. */
const RATE_TOLERANCE = 0.1;

export function figshareBisLineage(sampleRate = FIGSHARE_BIS_SAMPLE_RATE): DataLineage {
  return {
    deviceId: FIGSHARE_BIS_DEVICE_ID,
    deviceLabel: "figshare 5589841 bedside frontal EEG",
    transport: "ingest",
    channels: ["AF7"],
    sampleRate,
  };
}

export interface FigshareBisPoint {
  atSeconds: number;
  bis: number;
  appIndex: number;
  appSef: number | null;
  appSr: number | null;
  reliable: boolean;
  lagSeconds: number;
  externalRef: string;
}

export interface FigshareBisCase {
  caseRef: string;
  lineageKey: string;
  lineage: DataLineage;
  sampleRate: number;
  durationSeconds: number;
  points: FigshareBisPoint[];
  rejected: { badRange: number; unmatched: number; noIndex: number };
}

export interface FigsharePairOptions {
  /** One retained pair per this many seconds of case time. */
  strideSeconds?: number;
  /** How far a monitor reading may sit from a replayed second and still pair. */
  toleranceSeconds?: number;
}

/**
 * Derive the acquisition rate from the published cadence. Returns null when the
 * file's shape is not consistent with a 125 Hz recording sampled every 5 s —
 * the caller must drop the case rather than guess.
 */
export function deriveFigshareSampleRate(
  eegSamples: number,
  bisCount: number,
  intervalSeconds = FIGSHARE_BIS_INTERVAL_SECONDS,
): number | null {
  if (eegSamples <= 0 || bisCount <= 0 || intervalSeconds <= 0) return null;
  const rate = eegSamples / bisCount / intervalSeconds;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const drift = Math.abs(rate - FIGSHARE_BIS_SAMPLE_RATE) / FIGSHARE_BIS_SAMPLE_RATE;
  return drift <= RATE_TOLERANCE ? FIGSHARE_BIS_SAMPLE_RATE : null;
}

/**
 * Replay one case's EEG and pair each published BIS value with the replayed
 * second closest to it.
 */
export function pairFigshareBisCase(
  caseId: string,
  eeg: ArrayLike<number>,
  bis: ArrayLike<number>,
  options: FigsharePairOptions = {},
): FigshareBisCase {
  const stride = Math.max(1, options.strideSeconds ?? 10);
  const tolerance = options.toleranceSeconds ?? 2;
  const rejected = { badRange: 0, unmatched: 0, noIndex: 0 };

  const sampleRate = deriveFigshareSampleRate(eeg.length, bis.length);
  if (sampleRate == null) {
    throw new Error(
      `case ${caseId}: ${eeg.length} samples for ${bis.length} BIS values is not a 125 Hz / 5 s recording`,
    );
  }

  const samples = eeg instanceof Float64Array ? eeg : Float64Array.from(eeg);
  const replay = replayRawEeg({ samples, sampleRate });
  const frames = replay.frames;
  const lineage = figshareBisLineage(sampleRate);
  const caseRef = `figshare-${caseId}`;

  const points: FigshareBisPoint[] = [];
  let taken = -Infinity;
  let j = 0;
  for (let i = 0; i < bis.length; i++) {
    const t = i * FIGSHARE_BIS_INTERVAL_SECONDS;
    if (t - taken < stride) continue;
    const value = bis[i];
    if (value == null || !Number.isFinite(value) || value <= 0 || value > 100) {
      rejected.badRange++;
      continue;
    }
    while (j + 1 < frames.length && Math.abs(frames[j + 1]!.t - t) <= Math.abs(frames[j]!.t - t)) {
      j++;
    }
    const frame = frames[j];
    if (!frame || Math.abs(frame.t - t) > tolerance) {
      rejected.unmatched++;
      continue;
    }
    if (frame.appIndex == null) {
      rejected.noIndex++;
      continue;
    }
    points.push({
      atSeconds: t,
      bis: Number(value.toFixed(1)),
      appIndex: Number(frame.appIndex.toFixed(2)),
      appSef: Number(frame.sef95.toFixed(2)),
      appSr: Number(frame.suppressionRatio.toFixed(2)),
      // The record publishes no signal-quality index, so nothing here can claim
      // a reading was rejected by the monitor; reliability is left true and the
      // absence of an SQI travels with the row.
      reliable: true,
      lagSeconds: Number((frame.t - t).toFixed(2)),
      externalRef: `${FIGSHARE_BIS_SOURCE}:${caseId}:${t}`,
    });
    taken = t;
  }

  return {
    caseRef,
    lineageKey: lineageKey(lineage),
    lineage,
    sampleRate,
    durationSeconds: samples.length / sampleRate,
    points,
    rejected,
  };
}
