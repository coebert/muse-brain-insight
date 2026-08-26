/**
 * Real-time data-integrity accounting for the incoming EEG stream.
 *
 * Sits beside the ingest path and watches the raw notifications before the
 * filter chain sees them, so the bedside read-out can answer three questions
 * a clinician has to ask before trusting a number on screen:
 *
 *   - are packets being dropped by the radio link?
 *   - is the device sending unusable samples (NaN / Infinity)?
 *   - how often is the trace being hit by out-of-range spikes?
 *
 * Everything is reported twice: cumulatively for the whole case, and over a
 * short rolling window so a problem that started thirty seconds ago is
 * obvious even in a four-hour list.
 */

/** Anything beyond this is not cortical EEG — movement, diathermy, a knock. */
export const SPIKE_UV = 500;
/** Length of the rolling "right now" window, in seconds. */
export const INTEGRITY_WINDOW_SECONDS = 60;

export interface ChannelIntegrity {
  channel: string;
  /** Notifications received on this electrode. */
  frames: number;
  /** Samples received (including unusable ones). */
  samples: number;
  /** Samples expected by now from the nominal sample rate. */
  expected: number;
  /** Estimated samples never delivered (never negative). */
  droppedSamples: number;
  /** Estimated dropped notifications, at the device's frame size. */
  droppedFrames: number;
  /** Samples that were NaN or Infinity. */
  nonFinite: number;
  /** Samples beyond ±SPIKE_UV. */
  spikes: number;
  /** Seconds since the last notification on this electrode. */
  secondsSinceSample: number;
}

export interface IntegritySnapshot {
  /** Seconds of streaming accounted for. */
  elapsed: number;
  channels: ChannelIntegrity[];
  /** Whole-case totals across every electrode. */
  totals: {
    frames: number;
    samples: number;
    droppedSamples: number;
    droppedFrames: number;
    nonFinite: number;
    spikes: number;
  };
  /** Percentage of expected samples that never arrived (0–100). */
  dropoutPercent: number;
  /** NaN/Infinity samples per 1000 received samples. */
  nonFinitePerThousand: number;
  /** Spike samples per minute of streaming, across all electrodes. */
  spikesPerMinute: number;
  /** The same three measures over the last INTEGRITY_WINDOW_SECONDS. */
  recent: {
    seconds: number;
    dropoutPercent: number;
    nonFinitePerThousand: number;
    spikesPerMinute: number;
  };
  /** Overall verdict on the link, worst of the three measures. */
  grade: "good" | "fair" | "poor";
  /** Plain-language reasons behind a fair/poor grade. */
  reasons: string[];
}

interface ChannelState {
  frames: number;
  samples: number;
  nonFinite: number;
  spikes: number;
  lastSampleAt: number;
}

interface WindowEntry {
  at: number;
  samples: number;
  nonFinite: number;
  spikes: number;
}

const empty = (): ChannelState => ({
  frames: 0,
  samples: 0,
  nonFinite: 0,
  spikes: 0,
  lastSampleAt: 0,
});

/** Thresholds at which the link stops being trustworthy. */
const FAIR = { dropout: 1, nonFinite: 1, spikes: 6 };
const POOR = { dropout: 5, nonFinite: 10, spikes: 30 };

export class StreamIntegrityMonitor {
  private readonly fs: number;
  private readonly frameSamples: number;
  private channels = new Map<string, ChannelState>();
  private window: WindowEntry[] = [];
  private startedAt = 0;

  constructor(fs: number, frameSamples = 12) {
    this.fs = fs;
    this.frameSamples = frameSamples;
  }

  /** Begins (or restarts) accounting for a new case. */
  start(now = Date.now()) {
    this.channels = new Map();
    this.window = [];
    this.startedAt = now;
  }

  reset(now = Date.now()) {
    this.start(now);
  }

  /**
   * Records one notification, exactly as it arrived from the device. The
   * samples are inspected, never modified — sanitising is the filter chain's
   * job, this only counts what came in.
   */
  record(channel: string, samples: ArrayLike<number>, now = Date.now()) {
    if (!this.startedAt) this.startedAt = now;
    const state = this.channels.get(channel) ?? empty();
    let nonFinite = 0;
    let spikes = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const v = samples[i]!;
      if (!Number.isFinite(v)) nonFinite += 1;
      else if (Math.abs(v) > SPIKE_UV) spikes += 1;
    }
    state.frames += 1;
    state.samples += samples.length;
    state.nonFinite += nonFinite;
    state.spikes += spikes;
    state.lastSampleAt = now;
    this.channels.set(channel, state);
    this.window.push({ at: now, samples: samples.length, nonFinite, spikes });
    this.trim(now);
  }

  private trim(now: number) {
    const cutoff = now - INTEGRITY_WINDOW_SECONDS * 1000;
    let i = 0;
    while (i < this.window.length && this.window[i]!.at < cutoff) i += 1;
    if (i > 0) this.window = this.window.slice(i);
  }

  /** Current integrity picture. Safe to call every render. */
  snapshot(now = Date.now()): IntegritySnapshot {
    this.trim(now);
    const elapsed = this.startedAt ? Math.max(0, (now - this.startedAt) / 1000) : 0;
    const expectedPerChannel = elapsed * this.fs;

    const channels: ChannelIntegrity[] = [...this.channels.entries()]
      .map(([channel, s]) => {
        const dropped = Math.max(0, Math.round(expectedPerChannel - s.samples));
        return {
          channel,
          frames: s.frames,
          samples: s.samples,
          expected: Math.round(expectedPerChannel),
          droppedSamples: dropped,
          droppedFrames: Math.round(dropped / this.frameSamples),
          nonFinite: s.nonFinite,
          spikes: s.spikes,
          secondsSinceSample: s.lastSampleAt ? (now - s.lastSampleAt) / 1000 : elapsed,
        };
      })
      .sort((a, b) => a.channel.localeCompare(b.channel));

    const totals = channels.reduce(
      (acc, c) => ({
        frames: acc.frames + c.frames,
        samples: acc.samples + c.samples,
        droppedSamples: acc.droppedSamples + c.droppedSamples,
        droppedFrames: acc.droppedFrames + c.droppedFrames,
        nonFinite: acc.nonFinite + c.nonFinite,
        spikes: acc.spikes + c.spikes,
      }),
      { frames: 0, samples: 0, droppedSamples: 0, droppedFrames: 0, nonFinite: 0, spikes: 0 },
    );

    const expectedTotal = expectedPerChannel * channels.length;
    const dropoutPercent =
      expectedTotal > 0 ? Math.min(100, (totals.droppedSamples / expectedTotal) * 100) : 0;
    const nonFinitePerThousand =
      totals.samples > 0 ? (totals.nonFinite / totals.samples) * 1000 : 0;
    const spikesPerMinute = elapsed > 0 ? (totals.spikes / elapsed) * 60 : 0;

    // Rolling window: only meaningful once a little time has passed.
    const windowSeconds = Math.min(elapsed, INTEGRITY_WINDOW_SECONDS);
    const recentSamples = this.window.reduce((a, w) => a + w.samples, 0);
    const recentNonFinite = this.window.reduce((a, w) => a + w.nonFinite, 0);
    const recentSpikes = this.window.reduce((a, w) => a + w.spikes, 0);
    const recentExpected = windowSeconds * this.fs * Math.max(1, channels.length);
    const recent = {
      seconds: windowSeconds,
      dropoutPercent:
        recentExpected > 0
          ? Math.min(100, Math.max(0, ((recentExpected - recentSamples) / recentExpected) * 100))
          : 0,
      nonFinitePerThousand: recentSamples > 0 ? (recentNonFinite / recentSamples) * 1000 : 0,
      spikesPerMinute: windowSeconds > 0 ? (recentSpikes / windowSeconds) * 60 : 0,
    };

    // Grade on the rolling window once it has settled, else on the case so far.
    const judgeOn =
      windowSeconds >= 10
        ? recent
        : { dropoutPercent, nonFinitePerThousand, spikesPerMinute };
    const reasons: string[] = [];
    let grade: IntegritySnapshot["grade"] = "good";
    const note = (level: "fair" | "poor", text: string) => {
      reasons.push(text);
      if (level === "poor" || grade === "good") grade = level === "poor" ? "poor" : "fair";
    };
    if (judgeOn.dropoutPercent >= POOR.dropout)
      note("poor", `${judgeOn.dropoutPercent.toFixed(1)} % of packets are not arriving`);
    else if (judgeOn.dropoutPercent >= FAIR.dropout)
      note("fair", `${judgeOn.dropoutPercent.toFixed(1)} % packet dropout`);
    if (judgeOn.nonFinitePerThousand >= POOR.nonFinite)
      note("poor", `${judgeOn.nonFinitePerThousand.toFixed(1)} unusable samples per 1000`);
    else if (judgeOn.nonFinitePerThousand >= FAIR.nonFinite)
      note("fair", `${judgeOn.nonFinitePerThousand.toFixed(1)} unusable samples per 1000`);
    if (judgeOn.spikesPerMinute >= POOR.spikes)
      note("poor", `${Math.round(judgeOn.spikesPerMinute)} out-of-range spikes per minute`);
    else if (judgeOn.spikesPerMinute >= FAIR.spikes)
      note("fair", `${Math.round(judgeOn.spikesPerMinute)} out-of-range spikes per minute`);

    return {
      elapsed,
      channels,
      totals,
      dropoutPercent,
      nonFinitePerThousand,
      spikesPerMinute,
      recent,
      grade,
      reasons,
    };
  }
}

/** How the suppression timer spent the case, in seconds. */
export interface SuppressionClock {
  /** Seconds of EEG that were analysed and counted by the timer. */
  analysedSeconds: number;
  /** Cumulative isoelectric seconds reported to the clinician. */
  suppressionSeconds: number;
  /** Analysed seconds skipped as artefact (off-head, movement, diathermy). */
  excludedArtifactSeconds: number;
  /** Seconds skipped because the epoch straddled a data gap. */
  excludedGapSeconds: number;
  /** Wall-clock seconds since the case started. */
  elapsedSeconds: number;
  /** Analysed fraction of the case, 0–1 — the timer's coverage. */
  coverage: number;
  /** True while the timer is counting only validated, analysed seconds. */
  validOnly: true;
}

export function suppressionClock(input: {
  analysedSeconds: number;
  suppressionSeconds: number;
  excludedArtifactSeconds: number;
  excludedGapSeconds: number;
  elapsedSeconds: number;
}): SuppressionClock {
  const accounted =
    input.analysedSeconds + input.excludedArtifactSeconds + input.excludedGapSeconds;
  const denominator = Math.max(accounted, 0);
  return {
    ...input,
    coverage: denominator > 0 ? input.analysedSeconds / denominator : 0,
    validOnly: true,
  };
}
