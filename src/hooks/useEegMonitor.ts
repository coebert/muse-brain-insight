import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  DEFAULT_SETTINGS,
  EPOCH_SECONDS,
  EegAnalyzer,
  HOP_SECONDS,
  DSA_MAX_HZ,
  DSA_MIN_HZ,
  type AnalysisSettings,
  type DetectedEvent,
  type Epoch,
} from "@/lib/eeg/analysis";
import { montageFeatures, setActiveMontageFeatures } from "@/lib/eeg/psi-features";
import {
  MUSE_SAMPLE_RATE,
  computePsd,
  computePsdPair,
  type Psd,
  makeEegFilter,
  signalQuality,
  type FilterChain,
  type SignalQuality,
} from "@/lib/eeg/dsp";
import {
  MuseClient,
  SimulatedSource,
  type EegSource,
  type MuseChannel,
} from "@/lib/eeg/muse";
import {
  ANALYSIS_SAMPLE_RATE,
  MUSE_2_PROFILE,
  channelPairs,
  hemisphereChannels,
  setActiveDeviceProfile,
  type DeviceProfile,
} from "@/lib/eeg/device-profile";
import { createWaveformStore } from "@/lib/eeg/waveform-store";
import { createRawArchive } from "@/lib/eeg/raw-archive";
import { SidePreference, type SideDecision, type SideQuality } from "@/lib/eeg/side-preference";
import {
  accumulateChannelQuality,
  channelStatePoint,
  emptyChannelTallies,
  summariseChannelCompleteness,
  type ChannelCompleteness,
  type ChannelStatePoint,
} from "@/lib/eeg/channel-completeness";

export type { WaveformStore } from "@/lib/eeg/waveform-store";
export type { RawArchive } from "@/lib/eeg/raw-archive";
export type { SideDecision } from "@/lib/eeg/side-preference";

export type MonitorStatus = "idle" | "connecting" | "streaming" | "reconnecting" | "error";
export type SourceKind = "muse" | "simulated" | "ingest";

const BUFFER_SECONDS = 8;
const BUFFER_LEN = MUSE_SAMPLE_RATE * BUFFER_SECONDS;
const EPOCH_LEN = MUSE_SAMPLE_RATE * EPOCH_SECONDS;
/**
 * Long cases must never lose their earlier trend. Instead of dropping the
 * oldest hour we thin it: once the buffer is full, every second epoch older
 * than the most recent 30 minutes is discarded, halving the resolution of
 * history while keeping the whole case on screen.
 */
const MAX_EPOCHS = 7200;
const FULL_RES_EPOCHS = 1800;

/** Samples must arrive at least this recently for an epoch to be trustworthy. */
const STALE_SAMPLE_MS = 2500;

function compactEpochs(list: Epoch[]): Epoch[] {
  if (list.length <= MAX_EPOCHS) return list;
  const keepFrom = list.length - FULL_RES_EPOCHS;
  const older = list.slice(0, keepFrom).filter((_, i) => i % 2 === 0);
  return [...older, ...list.slice(keepFrom)];
}

/**
 * Default electrode groupings, kept for callers that render the standard
 * four-electrode montage. Live analysis uses the active device profile
 * instead, so a reduced montage groups by what the device actually provides.
 */
export const LEFT_CHANNELS: MuseChannel[] = hemisphereChannels(MUSE_2_PROFILE, "left");
export const RIGHT_CHANNELS: MuseChannel[] = hemisphereChannels(MUSE_2_PROFILE, "right");

export interface HemiSpectra {
  left: number[];
  right: number[];
}

/** Per-hemisphere clinical metrics, derived from that side's electrode pair. */
export interface HemiMetrics {
  suppressionRatio: number;
  seizureScore: number;
  seizureAlert: boolean;
  qualityGrade: SignalQuality["grade"];
  flat: boolean;
  /** 0–1 usability of this side's electrode pair. */
  qualityScore: number;
  /** 0–1 confidence in this side's spectral metrics (DSA, SEF95, bands). */
  spectralConfidence: number;
  /** Muscle/diathermy contamination share for this side (0–1). */
  emgIndex: number;
  /** Human-readable causes of quality loss on this side. */
  reasons: string[];
}

export interface HemiLatest {
  left: HemiMetrics;
  right: HemiMetrics;
}

export type HemiSide = "left" | "right";

/**
 * One point of the Signal Quality Index trend (BIS-style SQI history).
 * Values are 0–100 %.
 */
export interface SqiPoint {
  /** Seconds since session start. */
  t: number;
  /** Combined (worst-side) signal quality index. */
  sqi: number;
  left: number;
  right: number;
  /** Muscle contamination index for the epoch, 0–100 %. */
  emg: number;
}

/** DSA layout: stacked hemispheres, single mean lane, or overlaid traces. */
export type DsaView = "bilateral" | "combined" | "overlay";

/** A burst-suppression or seizure episode attributed to one hemisphere. */
export interface HemiEvent {
  side: HemiSide;
  kind: "suppression" | "seizure";
  /** Onset, seconds since session start. */
  t: number;
  /** Episode length in seconds (grows while the episode is running). */
  duration: number;
  /** True while the episode is still active. */
  ongoing: boolean;
  /** Peak suppression ratio (%) seen during the episode. */
  peakSr: number;
  /** Peak seizure score (0–1) seen during the episode. */
  peakScore: number;
  /** Signal quality grade at onset — how much to trust the marker. */
  quality: SignalQuality["grade"];
  /** Signal Quality Index (%) for that side at onset. */
  sqiAtOnset: number;
  /** Worst (lowest) SQI seen during the episode, %. */
  minSqi: number;
  /** EMG contamination (%) at onset. */
  emgAtOnset: number;
  /** Peak EMG contamination (%) during the episode. */
  peakEmg: number;
}

/** The less trustworthy of the two sides — used to label the combined DSA lane. */
export function worstHemi(latest: HemiLatest | null): HemiMetrics | null {
  if (!latest) return null;
  return latest.left.qualityScore <= latest.right.qualityScore ? latest.left : latest.right;
}

function compactHemi(list: HemiSpectra[]): HemiSpectra[] {
  if (list.length <= MAX_EPOCHS) return list;
  const keepFrom = list.length - FULL_RES_EPOCHS;
  const older = list.slice(0, keepFrom).filter((_, i) => i % 2 === 0);
  return [...older, ...list.slice(keepFrom)];
}

function compactChannelStates(list: ChannelStatePoint[]): ChannelStatePoint[] {
  if (list.length <= MAX_EPOCHS) return list;
  const keepFrom = list.length - FULL_RES_EPOCHS;
  const older = list.slice(0, keepFrom).filter((_, i) => i % 2 === 0);
  return [...older, ...list.slice(keepFrom)];
}

function compactSqi(list: SqiPoint[]): SqiPoint[] {
  if (list.length <= MAX_EPOCHS) return list;
  const keepFrom = list.length - FULL_RES_EPOCHS;
  const older = list.slice(0, keepFrom).filter((_, i) => i % 2 === 0);
  return [...older, ...list.slice(keepFrom)];
}

/**
 * Mean of the two hemispheres per frequency bin — the single combined DSA lane
 * used for fast bedside scanning.
 */
export function combineHemiSpectra(list: HemiSpectra[]): number[][] {
  return list.map((h) => {
    const n = Math.min(h.left.length, h.right.length);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = (h.left[i]! + h.right[i]!) / 2;
    return out;
  });
}

/** Spectral-edge (95 %) frequency of one dB spectrum frame, in Hz. */
function sef95FromSpectrum(db: number[]): number {
  if (!db.length) return DSA_MIN_HZ;
  const power = db.map((v) => Math.pow(10, v / 10));
  const total = power.reduce((a, b) => a + b, 0);
  if (total <= 0) return DSA_MIN_HZ;
  let acc = 0;
  for (let i = 0; i < power.length; i++) {
    acc += power[i]!;
    if (acc >= total * 0.95) {
      const frac = db.length > 1 ? i / (db.length - 1) : 0;
      return DSA_MIN_HZ + frac * (DSA_MAX_HZ - DSA_MIN_HZ);
    }
  }
  return DSA_MAX_HZ;
}

/**
 * Per-hemisphere spectral-edge traces for the overlay DSA view, so both sides
 * can be compared on a single chart.
 */
export function hemiSefTraces(list: HemiSpectra[]): { left: number[]; right: number[] } {
  return {
    left: list.map((h) => sef95FromSpectrum(h.left)),
    right: list.map((h) => sef95FromSpectrum(h.right)),
  };
}

interface ChannelBuffer {
  data: Float64Array;
  write: number;
  count: number;
  filter: FilterChain;
}

function makeBuffer(): ChannelBuffer {
  return { data: new Float64Array(BUFFER_LEN), write: 0, count: 0, filter: makeEegFilter() };
}

function readLast(buffer: ChannelBuffer, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const idx = (buffer.write - n + i + BUFFER_LEN * 2) % BUFFER_LEN;
    out[i] = buffer.data[idx]!;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Streaming state                                                     */
/* ------------------------------------------------------------------ */

/**
 * Everything the analysis loop produces, committed as one value.
 *
 * A hop used to fire eight separate `setState` calls; consumers could observe
 * a half-updated case (new epochs, stale hemisphere metrics). One reducer
 * action keeps the trend, the hemispheres and the quality read-outs in step.
 */
interface StreamState {
  epochs: Epoch[];
  hemiSpectra: HemiSpectra[];
  hemiLatest: HemiLatest | null;
  hemiEvents: HemiEvent[];
  sqiHistory: SqiPoint[];
  events: DetectedEvent[];
  elapsed: number;
  contactOk: Record<string, boolean>;
  channelQuality: Record<string, SignalQuality>;
  /** Per-electrode completeness rows for the whole case. */
  channelCompleteness: ChannelCompleteness[];
  /** Per-electrode state/noise samples over the case, for the timeline view. */
  channelStateHistory: ChannelStatePoint[];
  dataGapSeconds: number;
}

const INITIAL_STREAM: StreamState = {
  epochs: [],
  hemiSpectra: [],
  hemiLatest: null,
  hemiEvents: [],
  sqiHistory: [],
  events: [],
  elapsed: 0,
  contactOk: {},
  channelQuality: {},
  channelCompleteness: [],
  channelStateHistory: [],
  dataGapSeconds: 0,
};

type StreamAction =
  | { type: "reset" }
  | { type: "gap"; elapsed: number; dataGapSeconds: number }
  | { type: "events"; events: DetectedEvent[] }
  | {
      type: "epoch";
      elapsed: number;
      epoch: Epoch;
      events: DetectedEvent[];
      hemi: HemiSpectra;
      hemiLatest: HemiLatest;
      hemiEvents: HemiEvent[] | null;
      sqi: SqiPoint;
      contactOk: Record<string, boolean>;
      channelQuality: Record<string, SignalQuality>;
      channelCompleteness: ChannelCompleteness[];
      channelState: ChannelStatePoint;
    };

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "reset":
      return INITIAL_STREAM;
    case "gap":
      return { ...state, elapsed: action.elapsed, dataGapSeconds: action.dataGapSeconds };
    case "events":
      return { ...state, events: action.events };
    case "epoch":
      return {
        ...state,
        elapsed: action.elapsed,
        dataGapSeconds: 0,
        epochs: compactEpochs([...state.epochs, action.epoch]),
        events: action.events,
        hemiSpectra: compactHemi([...state.hemiSpectra, action.hemi]),
        hemiLatest: action.hemiLatest,
        hemiEvents: action.hemiEvents ?? state.hemiEvents,
        sqiHistory: compactSqi([...state.sqiHistory, action.sqi]),
        contactOk: action.contactOk,
        channelQuality: action.channelQuality,
        channelCompleteness: action.channelCompleteness,
        channelStateHistory: compactChannelStates([...state.channelStateHistory, action.channelState]),
      };
  }
}

export function useEegMonitor() {
  const [status, setStatus] = useState<MonitorStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string>("");
  const [batteryPercent, setBatteryPercent] = useState<number | null>(null);
  const [channel, setChannel] = useState<MuseChannel | "average">("average");
  const [settings, setSettings] = useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [stream, dispatch] = useReducer(streamReducer, INITIAL_STREAM);
  const {
    epochs,
    hemiSpectra,
    hemiLatest,
    hemiEvents,
    sqiHistory,
    events,
    elapsed,
    contactOk,
    channelQuality,
    channelCompleteness,
    channelStateHistory,
    dataGapSeconds,
  } = stream;
  // The live trace bypasses React state — see waveform-store.
  const waveformStoreRef = useRef(createWaveformStore());
  // Per-electrode rolling archive powering the raw-channel viewer.
  const rawArchiveRef = useRef(createRawArchive());
  const [reconnectAttempt, setReconnectAttempt] = useState<{
    attempt: number;
    attempts: number;
  } | null>(null);

  const buffersRef = useRef<Record<string, ChannelBuffer>>({});
  /**
   * Montage of the source currently streaming. Every per-channel loop below
   * reads it, so an absent electrode is never analysed as a flat one.
   */
  const profileRef = useRef<DeviceProfile>(MUSE_2_PROFILE);
  const [deviceProfile, setDeviceProfile] = useState<DeviceProfile>(MUSE_2_PROFILE);
  const sourceRef = useRef<EegSource | null>(null);
  /** Last successful connection request, so a manual retry can repeat it. */
  const lastConnectRef = useRef<{
    kind: SourceKind;
    device?: BluetoothDevice;
    preset?: string;
    source?: EegSource;
  } | null>(null);
  const analyzerRef = useRef(new EegAnalyzer(DEFAULT_SETTINGS));
  const leftAnalyzerRef = useRef(new EegAnalyzer(DEFAULT_SETTINGS));
  const rightAnalyzerRef = useRef(new EegAnalyzer(DEFAULT_SETTINGS));
  /** Chooses which hemisphere feeds the primary depth/SR/SEF metrics. */
  const sidePreferenceRef = useRef(new SidePreference());
  // Per-electrode completeness tallies for the current case.
  const channelTalliesRef = useRef(emptyChannelTallies());
  const [analysisSource, setAnalysisSource] = useState<SideDecision>({
    side: null,
    advantage: 0,
    reason: "Both hemispheres usable — primary metrics use the four-electrode average",
  });
  const startedAtRef = useRef<number>(0);
  const lastSampleAtRef = useRef<number>(0);
  const gapStartRef = useRef<number | null>(null);
  const manualEventsRef = useRef<DetectedEvent[]>([]);
  const hemiEventsRef = useRef<HemiEvent[]>([]);
  const channelRef = useRef(channel);
  channelRef.current = channel;

  /** Allocates a fresh ring buffer for every electrode in the montage. */
  const allocateBuffers = useCallback((p: DeviceProfile) => {
    const next: Record<string, ChannelBuffer> = {};
    for (const c of p.channels) next[c] = makeBuffer();
    buffersRef.current = next;
  }, []);

  if (Object.keys(buffersRef.current).length === 0) {
    allocateBuffers(profileRef.current);
  }

  useEffect(() => {
    analyzerRef.current.updateSettings(settings);
    leftAnalyzerRef.current.updateSettings(settings);
    rightAnalyzerRef.current.updateSettings(settings);
  }, [settings]);

  const activeSignal = useCallback((length: number): Float64Array => {
    const sel = channelRef.current;
    const channels = profileRef.current.channels;
    if (sel !== "average") {
      const buffer = buffersRef.current[sel];
      // The selected electrode may not exist on this device.
      if (buffer) return readLast(buffer, length);
    }
    const out = new Float64Array(length);
    if (channels.length === 0) return out;
    for (const c of channels) {
      const buf = buffersRef.current[c];
      if (!buf) continue;
      const seg = readLast(buf, length);
      for (let i = 0; i < length; i++) out[i] = out[i]! + seg[i]! / channels.length;
    }
    return out;
  }, []);

  /** Mean of the given electrodes, used for the per-hemisphere DSAs. */
  const groupSignal = useCallback((group: MuseChannel[], length: number): Float64Array => {
    const out = new Float64Array(length);
    // A hemisphere with no electrodes on this device stays at zero: the
    // side then reads as absent rather than as a failed electrode pair.
    if (group.length === 0) return out;
    for (const c of group) {
      const buf = buffersRef.current[c];
      if (!buf) continue;
      const seg = readLast(buf, length);
      for (let i = 0; i < length; i++) out[i] = out[i]! + seg[i]! / group.length;
    }
    return out;
  }, []);

  const stop = useCallback(async () => {
    await sourceRef.current?.stop();
    sourceRef.current = null;
    lastConnectRef.current = null;
    setReconnectAttempt(null);
    setBatteryPercent(null);
    setStatus("idle");
  }, []);

  const reset = useCallback(() => {
    analyzerRef.current.reset();
    leftAnalyzerRef.current.reset();
    rightAnalyzerRef.current.reset();
    sidePreferenceRef.current.reset();
    setAnalysisSource({
      side: null,
      advantage: 0,
      reason: "Both hemispheres usable — primary metrics use the four-electrode average",
    });
    manualEventsRef.current = [];
    hemiEventsRef.current = [];
    channelTalliesRef.current = emptyChannelTallies(profileRef.current.channels);
    dispatch({ type: "reset" });
    waveformStoreRef.current.set(new Float64Array(0));
    rawArchiveRef.current.reset();
    gapStartRef.current = null;
    startedAtRef.current = Date.now();
    allocateBuffers(profileRef.current);
  }, [allocateBuffers]);

  /** Appends a clinician annotation or audit entry to the session event log. */
  const addEvent = useCallback((event: DetectedEvent) => {
    manualEventsRef.current = [...manualEventsRef.current, event];
    dispatch({
      type: "events",
      events: [...analyzerRef.current.events, ...manualEventsRef.current],
    });
  }, []);

  const connect = useCallback(
    async (
      kind: SourceKind,
      options?: {
        preserveTimeline?: boolean;
        device?: BluetoothDevice;
        preset?: string;
        /** Pre-built source for generic ingest (file replay, serial, LSL bridge). */
        source?: EegSource;
      },
    ) => {
      setError(null);
      setStatus("connecting");
      try {
        let source: EegSource;
        if (kind === "ingest") {
          if (!options?.source)
            throw new Error("No ingest source was configured for this recording.");
          source = options.source;
        } else if (kind === "muse") {
          source = new MuseClient({
            ...(options?.device ? { device: options.device } : {}),
            ...(options?.preset ? { preset: options.preset } : {}),
          });
        } else {
          source = new SimulatedSource();
        }
        // Adopt the source's montage before any sample arrives, so buffers,
        // tallies and the hemisphere grouping match the hardware.
        const sourceProfile = source.profile ?? MUSE_2_PROFILE;
        profileRef.current = sourceProfile;
        setDeviceProfile(sourceProfile);
        setActiveDeviceProfile(sourceProfile);
        allocateBuffers(sourceProfile);
        if (channelRef.current !== "average" && !sourceProfile.channels.includes(channelRef.current)) {
          setChannel("average");
        }
        source.onDisconnect(() => {
          setBatteryPercent(null);
          // The case keeps running: hold the source so a manual retry can
          // re-open the same headband without losing anything recorded.
          setStatus("error");
          setReconnectAttempt(null);
        });
        source.onBattery?.((percent) => setBatteryPercent(percent));
        source.onState?.((state) => {
          if (state.kind === "reconnecting") {
            setStatus("reconnecting");
            setReconnectAttempt({ attempt: state.attempt, attempts: state.attempts });
            setError(null);
          } else if (state.kind === "connected") {
            setStatus("streaming");
            setReconnectAttempt(null);
          } else {
            setReconnectAttempt(null);
            setError(state.reason);
          }
        });
        await source.start((ch, samples) => {
          const buf = buffersRef.current[ch];
          if (!buf) return;
          lastSampleAtRef.current = Date.now();
          const filtered = new Float64Array(samples.length);
          for (let i = 0; i < samples.length; i++) {
            const v = buf.filter.process(samples[i]!);
            filtered[i] = v;
            buf.data[buf.write] = v;
            buf.write = (buf.write + 1) % BUFFER_LEN;
            if (buf.count < BUFFER_LEN) buf.count++;
          }
          rawArchiveRef.current.push(ch, filtered, ANALYSIS_SAMPLE_RATE);
        });
        sourceRef.current = source;
        lastConnectRef.current = {
          kind,
          ...(options?.device ? { device: options.device } : {}),
          ...(options?.preset ? { preset: options.preset } : {}),
          ...(options?.source ? { source: options.source } : {}),
        };
        setSourceName(source.name);
        if (!options?.preserveTimeline) reset();
        lastSampleAtRef.current = Date.now();
        setStatus("streaming");
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Could not connect to the headband.");
      }
    },
    [reset, allocateBuffers],
  );

  /**
   * Clinician-triggered reconnection. Never resets the timeline: the trend,
   * events, markers and raw archive from the case so far are preserved.
   */
  const reconnect = useCallback(async (): Promise<boolean> => {
    const source = sourceRef.current;
    setError(null);
    if (source?.reconnect) {
      setStatus("reconnecting");
      const ok = await source.reconnect();
      if (ok) {
        lastSampleAtRef.current = Date.now();
        setStatus("streaming");
        setReconnectAttempt(null);
        return true;
      }
      setStatus("error");
      setError("Reconnection failed — check the headband is on, charged and in range.");
      return false;
    }
    const last = lastConnectRef.current;
    if (!last) return false;
    if (last.kind === "ingest") {
      // Replaying the file again would append the whole recording a second
      // time; the clinician starts a fresh case instead.
      setStatus("error");
      setError("Imported recordings cannot be resumed — start a new case to replay the file again.");
      return false;
    }
    await sourceRef.current?.stop();
    sourceRef.current = null;
    await connect(last.kind, {
      preserveTimeline: true,
      ...(last.device ? { device: last.device } : {}),
      ...(last.preset ? { preset: last.preset } : {}),
    });
    return true;
  }, [connect]);

  // Epoch analysis loop. It also runs while the link is down so the missing
  // time is recorded as a gap rather than vanishing from the timeline.
  useEffect(() => {
    if (status !== "streaming" && status !== "reconnecting" && status !== "error") return;
    const id = setInterval(() => {
      const profile = profileRef.current;
      const channels = profile.channels;
      const anyBuffer = channels.length ? buffersRef.current[channels[0]!] : null;
      if (!anyBuffer || anyBuffer.count < EPOCH_LEN) return;
      const t = (Date.now() - startedAtRef.current) / 1000;

      // No fresh samples: leave a real gap in the trend rather than
      // re-analysing stale buffer contents.
      if (Date.now() - lastSampleAtRef.current > STALE_SAMPLE_MS) {
        if (gapStartRef.current == null) gapStartRef.current = t;
        dispatch({ type: "gap", elapsed: t, dataGapSeconds: t - gapStartRef.current });
        return;
      }
      if (gapStartRef.current != null) {
        const gap = t - gapStartRef.current;
        gapStartRef.current = null;
        if (gap >= 3) {
          manualEventsRef.current = [
            ...manualEventsRef.current,
            {
              kind: "signal_quality",
              severity: "warning",
              t: t - gap,
              duration: gap,
              detail: `No EEG received for ${Math.round(gap)} s — marked as a data gap and excluded from analysis.`,
            },
          ];
        }
      }

      const contact: Record<string, boolean> = {};
      const quality: Record<string, SignalQuality> = {};
      // Channels are rated in pairs: two real spectra come out of one complex
      // FFT, halving the per-second transform load with identical numbers.
      for (const [ca, cb] of channelPairs(profile)) {
        const bufA = buffersRef.current[ca];
        if (!bufA) continue;
        const segA = readLast(bufA, MUSE_SAMPLE_RATE * 2);
        if (!cb || !buffersRef.current[cb]) {
          const q = signalQuality(segA, computePsd(segA, MUSE_SAMPLE_RATE), MUSE_SAMPLE_RATE);
          quality[ca] = q;
          contact[ca] = !q.flat && q.grade !== "poor";
          continue;
        }
        const segB = readLast(buffersRef.current[cb]!, MUSE_SAMPLE_RATE * 2);
        const [psdA, psdB] = computePsdPair(segA, segB, MUSE_SAMPLE_RATE);
        const qa = signalQuality(segA, psdA, MUSE_SAMPLE_RATE);
        const qb = signalQuality(segB, psdB, MUSE_SAMPLE_RATE);
        quality[ca] = qa;
        quality[cb] = qb;
        contact[ca] = !qa.flat && qa.grade !== "poor";
        contact[cb] = !qb.flat && qb.grade !== "poor";
      }

      // --- primary analysis source -------------------------------------------
      // Depth index, suppression ratio and SEF95 come from the four-electrode
      // average unless one hemisphere is clearly cleaner, in which case that
      // side alone drives them so a bad electrode pair cannot degrade them.
      const leftChannels = hemisphereChannels(profile, "left");
      const rightChannels = hemisphereChannels(profile, "right");
      const sideQuality = (group: MuseChannel[]): SideQuality => {
        const grades = group.map((c) => quality[c]);
        return {
          score: grades.length ? Math.min(...grades.map((q) => q?.score ?? 0)) : 0,
          flat: group.every((c) => quality[c]?.flat ?? false),
          grade: grades.some((q) => q?.grade === "poor")
            ? "poor"
            : grades.some((q) => q?.grade === "fair")
              ? "fair"
              : "good",
        };
      };
      // Side preference only means something when both sides are populated.
      const decision =
        channelRef.current === "average" && leftChannels.length > 0 && rightChannels.length > 0
          ? sidePreferenceRef.current.update(
              sideQuality(leftChannels),
              sideQuality(rightChannels),
            )
          : channelRef.current === "average"
            ? {
                side: null,
                advantage: 0,
                reason: `${profile.label}: unilateral montage — primary metrics use every available electrode`,
              }
            : {
              side: null,
              advantage: 0,
              reason: `Single electrode (${channelRef.current}) selected — primary metrics use it directly`,
            };
      setAnalysisSource((prev) =>
        prev.side === decision.side && Math.abs(prev.advantage - decision.advantage) < 0.02
          ? prev
          : decision,
      );
      const primarySignal = decision.side
        ? groupSignal(decision.side === "left" ? leftChannels : rightChannels, EPOCH_LEN)
        : activeSignal(EPOCH_LEN);
      const epoch = analyzerRef.current.analyze(primarySignal, t);

      // Side-specific metrics so alarms can name the affected hemisphere.
      const MAX_HEMI_EVENTS = 400;
      // Only republish the episode list when something visible changed.
      let hemiDirty = false;
      /** Opens, extends or closes a hemisphere episode marker. */
      const trackHemiEvent = (
        side: HemiSide,
        kind: HemiEvent["kind"],
        active: boolean,
        sr: number,
        score: number,
        grade: SignalQuality["grade"],
        sqi: number,
        emg: number,
      ) => {
        const list = hemiEventsRef.current;
        const open = list.find((e) => e.side === side && e.kind === kind && e.ongoing);
        if (active) {
          hemiDirty = true;
          if (open) {
            open.duration = Math.max(HOP_SECONDS, t - open.t);
            open.peakSr = Math.max(open.peakSr, sr);
            open.peakScore = Math.max(open.peakScore, score);
            open.minSqi = Math.min(open.minSqi, sqi);
            open.peakEmg = Math.max(open.peakEmg, emg);
          } else {
            list.push({
              side,
              kind,
              t,
              duration: HOP_SECONDS,
              ongoing: true,
              peakSr: sr,
              peakScore: score,
              quality: grade,
              sqiAtOnset: sqi,
              minSqi: sqi,
              emgAtOnset: emg,
              peakEmg: emg,
            });
          }
        } else if (open) {
          hemiDirty = true;
          open.ongoing = false;
          open.duration = Math.max(HOP_SECONDS, t - open.t);
        }
        if (list.length > MAX_HEMI_EVENTS) list.splice(0, list.length - MAX_HEMI_EVENTS);
      };

      const sideMetrics = (
        side: HemiSide,
        group: MuseChannel[],
        analyzer: EegAnalyzer,
        signal: Float64Array,
        psd: Psd,
      ): { metrics: HemiMetrics; spectrum: number[] } => {
        const e = analyzer.analyze(signal, t, psd);
        const grades = group.map((c) => quality[c]);
        const worst: SignalQuality["grade"] = grades.some((q) => q?.grade === "poor")
          ? "poor"
          : grades.some((q) => q?.grade === "fair")
            ? "fair"
            : "good";
        const flatSide = group.every((c) => quality[c]?.flat ?? false);
        const sideScore = grades.length ? Math.min(...grades.map((q) => q?.score ?? 0)) : 0;
        const sideSqi = (flatSide ? 0 : sideScore) * 100;
        const sideEmg = Math.max(...grades.map((q) => q?.emgIndex ?? 0), 0) * 100;
        trackHemiEvent(
          side,
          "suppression",
          e.isSuppressed,
          e.suppressionRatio,
          e.seizureScore,
          worst,
          sideSqi,
          sideEmg,
        );
        trackHemiEvent(
          side,
          "seizure",
          e.seizureAlert,
          e.suppressionRatio,
          e.seizureScore,
          worst,
          sideSqi,
          sideEmg,
        );
        const metrics: HemiMetrics = {
          suppressionRatio: e.suppressionRatio,
          seizureScore: e.seizureScore,
          seizureAlert: e.seizureAlert,
          qualityGrade: worst,
          flat: flatSide,
          qualityScore: sideScore,
          spectralConfidence: e.confidence.spectral,
          emgIndex: Math.max(...grades.map((q) => q?.emgIndex ?? 0), 0),
          reasons: Array.from(new Set(grades.flatMap((q) => q?.reasons ?? []))),
        };
        // The analyser already produced this side's dB spectrum over the DSA
        // range, so the hemisphere lane reuses it instead of re-running an FFT.
        return { metrics, spectrum: e.spectrum };
      };
      // Both hemisphere spectra also come from a single paired FFT.
      const leftSignal = groupSignal(leftChannels, EPOCH_LEN);
      const rightSignal = groupSignal(rightChannels, EPOCH_LEN);
      const [leftPsd, rightPsd] = computePsdPair(leftSignal, rightSignal, MUSE_SAMPLE_RATE);
      const left = sideMetrics("left", leftChannels, leftAnalyzerRef.current, leftSignal, leftPsd);
      const right = sideMetrics(
        "right",
        rightChannels,
        rightAnalyzerRef.current,
        rightSignal,
        rightPsd,
      );
      const leftMetrics = left.metrics;
      const rightMetrics = right.metrics;
      const hemi: HemiSpectra = { left: left.spectrum, right: right.spectrum };
      // Publish the bilateral montage evidence (SedLine/PSI-style coherence,
      // asymmetry and spectral shape) for the COEBIS adjunct stage. It is read
      // on the next epoch, a one-second lag that is immaterial at this scale.
      setActiveMontageFeatures(
        montageFeatures(left.spectrum, right.spectrum, DSA_MIN_HZ, DSA_MAX_HZ),
      );

      // BIS-style Signal Quality Index trend: one point per epoch, thinned
      // with the same rule as the DSA so long cases keep their full history.
      const leftSqi = (leftMetrics.flat ? 0 : leftMetrics.qualityScore) * 100;
      const rightSqi = (rightMetrics.flat ? 0 : rightMetrics.qualityScore) * 100;
      const point: SqiPoint = {
        t,
        left: leftSqi,
        right: rightSqi,
        sqi: Math.min(leftSqi, rightSqi),
        emg: Math.max(leftMetrics.emgIndex, rightMetrics.emgIndex) * 100,
      };
      dispatch({
        type: "epoch",
        elapsed: t,
        epoch,
        events: [...analyzerRef.current.events, ...manualEventsRef.current],
        hemi,
        hemiLatest: { left: leftMetrics, right: rightMetrics },
        // Only republish the episode list when something visible changed.
        hemiEvents: hemiDirty ? hemiEventsRef.current.map((e) => ({ ...e })) : null,
        sqi: point,
        contactOk: contact,
        channelQuality: quality,
        channelCompleteness: summariseChannelCompleteness(
          accumulateChannelQuality(channelTalliesRef.current, quality, channels),
          HOP_SECONDS,
          channels,
        ),
        channelState: channelStatePoint(t, quality, channels),
      });
    }, HOP_SECONDS * 1000);
    return () => clearInterval(id);
  }, [status, activeSignal, groupSignal]);

  // Waveform refresh.
  useEffect(() => {
    if (status !== "streaming" && status !== "reconnecting") return;
    const store = waveformStoreRef.current;
    const id = setInterval(() => {
      store.set(activeSignal(MUSE_SAMPLE_RATE * 4));
    }, 200);
    return () => clearInterval(id);
  }, [status, activeSignal]);

  useEffect(() => {
    return () => {
      void sourceRef.current?.stop();
    };
  }, []);

  const latest = epochs.length ? epochs[epochs.length - 1]! : null;

  const summary = useMemo(() => {
    if (!epochs.length) {
      return {
        meanSr: 0,
        maxSr: 0,
        suppressionSeconds: 0,
        seizureAlerts: 0,
        meanQuality: 0,
        usableFraction: 0,
      };
    }
    const meanSr = (epochs.reduce((a, e) => a + e.epochSuppression, 0) / epochs.length) * 100;
    const maxSr = epochs.reduce((a, e) => Math.max(a, e.suppressionRatio), 0);
    return {
      meanSr,
      maxSr,
      suppressionSeconds: analyzerRef.current.suppressionSeconds,
      seizureAlerts: events.filter((e) => e.kind === "seizure").length,
      meanQuality: epochs.reduce((a, e) => a + e.quality.score, 0) / epochs.length,
      usableFraction: epochs.filter((e) => e.quality.grade !== "poor").length / epochs.length,
    };
  }, [epochs, events]);

  return {
    status,
    error,
    sourceName,
    batteryPercent,
    channel,
    setChannel,
    settings,
    setSettings,
    epochs,
    hemiSpectra,
    hemiLatest,
    hemiEvents,
    sqiHistory,
    events,
    latest,
    waveformStore: waveformStoreRef.current,
    rawArchive: rawArchiveRef.current,
    elapsed,
    contactOk,
    channelQuality,
    channelCompleteness,
    channelStateHistory,
    summary,
    deviceProfile,
    reconnectAttempt,
    analysisSource,
    dataGapSeconds,
    addEvent,
    connect,
    reconnect,
    stop,
    reset,
  };
}
