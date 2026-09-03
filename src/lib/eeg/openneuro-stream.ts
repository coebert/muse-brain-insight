/**
 * Whole-recording (streamed) intake for OpenNeuro ds004541.
 *
 * A ds004541 EDF is a complete anaesthetic: 58 channels at 1000 Hz, commonly
 * 300 MB or more. Fetching a prefix gave only the opening minutes, which never
 * reached loss of consciousness, so the published depth events could not be
 * used. This module decodes the *entire* file without ever holding it, by
 * requesting record-aligned byte ranges, decoding one frontal channel from each
 * range, and keeping only:
 *
 *  - the derived 4 s DSA epochs, and
 *  - a decimated copy of the channel (≈128 Hz) for one whole-recording replay.
 *
 * An hour at 128 Hz is a few megabytes, so the replay that produces app indices
 * still sees the recording as one continuous signal — the estimator is not
 * restarted at every chunk boundary, which would corrupt suppression timing.
 */

import { decodeEdfChunk, pickEdfChannel, planEdfChunks, type EdfChunkPlan, type EdfHeader } from "./edf";
import {
  OPENNEURO_DS004541_SOURCE,
  OPENNEURO_PREFERRED_CHANNELS,
  eventsToStateIntervals,
  type BidsEvent,
} from "./openneuro";
import { applyAnnotations, type PathologyAnnotation } from "./pathology-datasets";
import { deriveEpochsFromRaw, type PhysionetEpoch } from "./physionet";

/** Rate the decimated replay copy is held at. */
export const REPLAY_SAMPLE_RATE = 128;

export interface StreamedRecording {
  epochs: PhysionetEpoch[];
  intervals: PathologyAnnotation[];
  channel: string;
  sampleRate: number;
  durationSeconds: number;
  labelledIntervals: number;
  /** Decimated single-channel signal for replay, oldest sample first. */
  replaySignal: Float64Array;
  replaySampleRate: number;
  chunksDecoded: number;
  bytesDecoded: number;
}

/** Average-decimate to approximately the target rate. */
export function decimate(
  signal: Float64Array,
  sampleRate: number,
  targetRate = REPLAY_SAMPLE_RATE,
): { signal: Float64Array; sampleRate: number } {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  if (factor === 1) return { signal, sampleRate };
  const n = Math.floor(signal.length / factor);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += signal[i * factor + k]!;
    out[i] = sum / factor;
  }
  return { signal: out, sampleRate: sampleRate / factor };
}

/**
 * Accumulates decoded chunks of one recording. The caller owns the transport;
 * this class owns every decision about the signal.
 */
export class OpenNeuroStreamAssembler {
  private readonly channelIndex: number;
  private readonly epochs: PhysionetEpoch[] = [];
  private readonly replayParts: Float64Array[] = [];
  private carry: Float64Array = new Float64Array(0);
  private carryStartSeconds = 0;
  private decimatedRate = REPLAY_SAMPLE_RATE;
  private samplesSeen = 0;
  chunksDecoded = 0;
  bytesDecoded = 0;

  constructor(
    private readonly header: EdfHeader,
    private readonly meta: { caseRef: string; fileName: string },
    preferred: string[] = OPENNEURO_PREFERRED_CHANNELS,
  ) {
    this.channelIndex = pickEdfChannel(header.channels, preferred);
  }

  get channel(): string {
    return (this.header.channels[this.channelIndex] ?? "eeg").trim();
  }

  get sampleRate(): number {
    const perRecord = this.header.samplesPerRecord[this.channelIndex] ?? 0;
    return perRecord / this.header.recordDurationSeconds;
  }

  plan(targetBytes: number): EdfChunkPlan[] {
    return planEdfChunks(this.header, targetBytes);
  }

  /** Decode one range response (data records only) and fold it in. */
  push(dataBytes: Uint8Array, chunk: EdfChunkPlan): void {
    const decoded = decodeEdfChunk(dataBytes, this.header, this.channelIndex);
    if (!decoded.signal.length) return;
    this.chunksDecoded++;
    this.bytesDecoded += dataBytes.byteLength;

    // Epochs are derived on a signal that carries the tail of the previous
    // chunk, so a 4 s window is never lost at a boundary.
    const joined = new Float64Array(this.carry.length + decoded.signal.length);
    joined.set(this.carry, 0);
    joined.set(decoded.signal, this.carry.length);
    const sr = decoded.sampleRate;
    const derived = deriveEpochsFromRaw(joined, sr, {
      caseRef: this.meta.caseRef,
      channel: decoded.channel,
    });
    for (const e of derived) {
      this.epochs.push({ ...e, atSeconds: e.atSeconds + this.carryStartSeconds });
    }

    const dec = decimate(decoded.signal, sr);
    this.decimatedRate = dec.sampleRate;
    this.replayParts.push(dec.signal);
    this.samplesSeen += decoded.signal.length;

    // Keep the remainder that did not fill a whole 4 s window.
    const win = Math.round(4 * sr);
    const consumed = derived.length ? (derived.length - 1) * win + win : 0;
    const tail = joined.subarray(consumed);
    this.carry = Float64Array.from(tail);
    this.carryStartSeconds = chunk.startSeconds + decoded.durationSeconds - tail.length / sr;
  }

  finish(events: BidsEvent[]): StreamedRecording {
    const sr = this.sampleRate;
    const durationSeconds = this.samplesSeen / sr;
    if (!this.epochs.length) throw new Error("no usable epochs were derived");

    const intervals = eventsToStateIntervals(events, durationSeconds);
    const channel = this.channel;
    const labelled = applyAnnotations(this.epochs, intervals, { channel }).map((e) => ({
      ...e,
      externalRef: `${OPENNEURO_DS004541_SOURCE}:${this.meta.caseRef}:${channel}:${e.atSeconds.toFixed(3)}`,
    }));

    const total = this.replayParts.reduce((a, p) => a + p.length, 0);
    const replaySignal = new Float64Array(total);
    let at = 0;
    for (const part of this.replayParts) {
      replaySignal.set(part, at);
      at += part.length;
    }

    return {
      epochs: labelled,
      intervals,
      channel,
      sampleRate: sr,
      durationSeconds,
      labelledIntervals: intervals.length,
      replaySignal,
      replaySampleRate: this.decimatedRate,
      chunksDecoded: this.chunksDecoded,
      bytesDecoded: this.bytesDecoded,
    };
  }
}
