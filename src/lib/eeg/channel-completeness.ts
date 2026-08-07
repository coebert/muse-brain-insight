import type { SignalQuality } from "@/lib/eeg/dsp";
import { MUSE_CHANNELS, type MuseChannel } from "@/lib/eeg/muse";

/** Running per-electrode tallies accumulated once per analysis hop. */
export interface ChannelTally {
  channel: MuseChannel;
  /** Epochs in which this electrode was rated. */
  epochs: number;
  good: number;
  fair: number;
  poor: number;
  /** Epochs where the electrode was flat/disconnected (no EEG at all). */
  flat: number;
  /** Sum of quality scores (0–1) for averaging. */
  scoreSum: number;
  /** Sum of EMG contamination indices (0–1) for averaging. */
  emgSum: number;
  /** Longest consecutive run of unusable epochs. */
  worstRunEpochs: number;
  /** Current consecutive run of unusable epochs. */
  currentRunEpochs: number;
}

export type ChannelTallies = Record<MuseChannel, ChannelTally>;

export function emptyChannelTallies(): ChannelTallies {
  const out = {} as ChannelTallies;
  for (const channel of MUSE_CHANNELS) {
    out[channel] = {
      channel,
      epochs: 0,
      good: 0,
      fair: 0,
      poor: 0,
      flat: 0,
      scoreSum: 0,
      emgSum: 0,
      worstRunEpochs: 0,
      currentRunEpochs: 0,
    };
  }
  return out;
}

/** Mutates the tallies with one hop's per-channel quality read-outs. */
export function accumulateChannelQuality(
  tallies: ChannelTallies,
  quality: Record<string, SignalQuality | undefined>,
): ChannelTallies {
  for (const channel of MUSE_CHANNELS) {
    const q = quality[channel];
    const tally = tallies[channel];
    if (!q) continue;
    tally.epochs += 1;
    tally.scoreSum += q.score;
    tally.emgSum += q.emgIndex;
    if (q.flat) tally.flat += 1;
    if (q.grade === "good") tally.good += 1;
    else if (q.grade === "fair") tally.fair += 1;
    else tally.poor += 1;
    const unusable = q.flat || q.grade === "poor";
    tally.currentRunEpochs = unusable ? tally.currentRunEpochs + 1 : 0;
    if (tally.currentRunEpochs > tally.worstRunEpochs) tally.worstRunEpochs = tally.currentRunEpochs;
  }
  return tallies;
}

export interface ChannelCompleteness {
  channel: MuseChannel;
  side: "left" | "right";
  /** Fraction of rated epochs that were usable (not flat, not poor), 0–1. */
  usableFraction: number;
  /** Fraction of rated epochs the electrode was flat/off-head, 0–1. */
  flatFraction: number;
  /** Fraction of rated epochs graded poor (noisy), 0–1. */
  poorFraction: number;
  /** Mean quality score, 0–1. */
  meanScore: number;
  /** Mean EMG contamination, 0–1. */
  meanEmg: number;
  /** Longest unusable stretch, in seconds. */
  worstRunSeconds: number;
  /** Total unusable time, in seconds. */
  missingSeconds: number;
  epochs: number;
  level: "ok" | "partial" | "poor";
  /** Short human-readable reason when not "ok". */
  note: string | null;
}

const SIDE: Record<MuseChannel, "left" | "right"> = {
  TP9: "left",
  AF7: "left",
  AF8: "right",
  TP10: "right",
};

/** Turns raw tallies into per-electrode completeness rows for the UI. */
export function summariseChannelCompleteness(
  tallies: ChannelTallies,
  hopSeconds: number,
): ChannelCompleteness[] {
  return MUSE_CHANNELS.map((channel) => {
    const t = tallies[channel];
    const n = Math.max(0, t.epochs);
    const usable = n ? (n - t.flat - t.poor + Math.min(t.flat, 0)) / n : 0;
    const usableFraction = n ? Math.max(0, Math.min(1, (n - Math.max(t.poor, t.flat)) / n)) : 0;
    const flatFraction = n ? t.flat / n : 0;
    const poorFraction = n ? t.poor / n : 0;
    const meanScore = n ? t.scoreSum / n : 0;
    const meanEmg = n ? t.emgSum / n : 0;
    const missingSeconds = Math.round(Math.max(t.poor, t.flat) * hopSeconds);
    const level: ChannelCompleteness["level"] =
      n === 0 ? "poor" : usableFraction >= 0.9 ? "ok" : usableFraction >= 0.7 ? "partial" : "poor";
    let note: string | null = null;
    if (n === 0) note = "No data yet";
    else if (flatFraction > 0.2) note = `Flat/off-head for ${(flatFraction * 100).toFixed(0)}% of the case`;
    else if (poorFraction > 0.2) note = `Noisy for ${(poorFraction * 100).toFixed(0)}% of the case`;
    else if (meanEmg > 0.4) note = "High muscle contamination";
    void usable;
    return {
      channel,
      side: SIDE[channel],
      usableFraction,
      flatFraction,
      poorFraction,
      meanScore,
      meanEmg,
      worstRunSeconds: Math.round(t.worstRunEpochs * hopSeconds),
      missingSeconds,
      epochs: n,
      level,
      note,
    };
  });
}
