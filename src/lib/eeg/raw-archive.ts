/**
 * A rolling, per-electrode archive of the filtered EEG.
 *
 * The dashboard trace only ever showed a 4 s window of the averaged signal.
 * Reviewing what an individual electrode was doing five minutes ago — the
 * usual question when a marker fires — needs the samples kept somewhere, so
 * every channel gets its own ring buffer here.
 *
 * Samples are decimated to {@link RAW_ARCHIVE_HZ} (the analysis band tops out
 * at 45 Hz, so 128 Hz is oversampled already) and capped at
 * {@link RAW_ARCHIVE_SECONDS}, which keeps the whole thing to a few MB.
 */

export const RAW_ARCHIVE_HZ = 128;
export const RAW_ARCHIVE_SECONDS = 60 * 60;
const CAPACITY = RAW_ARCHIVE_HZ * RAW_ARCHIVE_SECONDS;

interface ChannelRing {
  data: Float32Array;
  /** Next write index into the ring. */
  write: number;
  /** Total samples ever written (monotonic; used for absolute time). */
  total: number;
  /** Decimation phase counter. */
  phase: number;
  /** Wall-clock time the channel's first archived sample represents. */
  startedAt: number | null;
}

/**
 * A dropout writes nothing, so without correction the archive would simply
 * carry on where it left off and every later sample would replay early — the
 * waveform sliding out of step with the index trace, markers and notes by the
 * whole length of the outage. Silence is written across the gap instead, so
 * the archive stays on the case clock.
 *
 * Below this much drift nothing is written: sample rates are never exact and
 * padding small jitter would add noise where there was none.
 */
export const GAP_TOLERANCE_SECONDS = 0.5;

export interface RawArchive {
  subscribe: (listener: () => void) => () => void;
  /** Bumped whenever new samples land; use as a `useSyncExternalStore` snapshot. */
  getVersion: () => number;
  /** Append filtered samples for one electrode, at the acquisition rate. */
  push: (channel: string, samples: ArrayLike<number>, sourceHz: number) => void;
  /** Seconds of signal held for a channel (0 when the channel is silent). */
  duration: (channel: string) => number;
  /**
   * Time in seconds, on the same clock as {@link RawArchive.read}, of the
   * oldest sample still held for a channel. Anything before this has fallen
   * out of the ring and reads back as silence.
   */
  retainedFrom: (channel: string) => number;
  /** Longest duration across all channels — the review timeline length. */
  span: () => number;
  /**
   * Samples for `channel` between two times in seconds since the channel's
   * first archived sample. Missing regions come back as zeroes.
   */
  read: (channel: string, fromSeconds: number, toSeconds: number) => Float32Array;
  reset: () => void;
}

const EMPTY = new Float32Array(0);

export function createRawArchive(): RawArchive {
  const rings = new Map<string, ChannelRing>();
  const listeners = new Set<() => void>();
  let version = 0;

  const ringFor = (channel: string): ChannelRing => {
    let ring = rings.get(channel);
    if (!ring) {
      ring = {
        data: new Float32Array(CAPACITY),
        write: 0,
        total: 0,
        phase: 0,
        startedAt: null,
      };
      rings.set(channel, ring);
    }
    return ring;
  };

  const writeSample = (ring: ChannelRing, value: number) => {
    ring.data[ring.write] = value;
    ring.write = (ring.write + 1) % CAPACITY;
    ring.total++;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    push(channel, samples, sourceHz, nowMs = Date.now()) {
      const ring = ringFor(channel);
      const chunkMs = sourceHz > 0 ? (samples.length / sourceHz) * 1000 : 0;
      const chunkStart = nowMs - chunkMs;

      if (ring.startedAt == null) {
        ring.startedAt = chunkStart;
      } else {
        // Where this chunk should land on the case clock, versus where the
        // archive actually is. Any shortfall is time the headband was away.
        const expected = Math.round(((chunkStart - ring.startedAt) / 1000) * RAW_ARCHIVE_HZ);
        const missing = expected - ring.total;
        if (missing > GAP_TOLERANCE_SECONDS * RAW_ARCHIVE_HZ) {
          const pad = Math.min(missing, CAPACITY);
          for (let i = 0; i < pad; i++) writeSample(ring, 0);
          // Everything older than the pad has been pushed out of the ring
          // anyway, so the clock stays consistent with what is retained.
          ring.total += missing - pad;
          ring.phase = 0;
        }
      }

      const step = Math.max(1, Math.round(sourceHz / RAW_ARCHIVE_HZ));
      for (let i = 0; i < samples.length; i++) {
        if (ring.phase % step === 0) writeSample(ring, samples[i] as number);
        ring.phase++;
      }
      version++;
      for (const l of listeners) l();
    },
    duration(channel) {
      const ring = rings.get(channel);
      return ring ? ring.total / RAW_ARCHIVE_HZ : 0;
    },
    retainedFrom(channel) {
      const ring = rings.get(channel);
      if (!ring) return 0;
      return Math.max(0, ring.total - CAPACITY) / RAW_ARCHIVE_HZ;
    },
    span() {
      let max = 0;
      for (const ring of rings.values()) max = Math.max(max, ring.total / RAW_ARCHIVE_HZ);
      return max / 1;
    },
    read(channel, fromSeconds, toSeconds) {
      const ring = rings.get(channel);
      if (!ring || ring.total === 0) return EMPTY;
      const startIdx = Math.max(0, Math.round(fromSeconds * RAW_ARCHIVE_HZ));
      const endIdx = Math.min(ring.total, Math.round(toSeconds * RAW_ARCHIVE_HZ));
      const n = endIdx - startIdx;
      if (n <= 0) return EMPTY;
      const oldest = Math.max(0, ring.total - CAPACITY);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const abs = startIdx + i;
        if (abs < oldest) continue; // fell out of the ring
        out[i] = ring.data[abs % CAPACITY] as number;
      }
      return out;
    },
    reset() {
      rings.clear();
      version++;
      for (const l of listeners) l();
    },
  };
}