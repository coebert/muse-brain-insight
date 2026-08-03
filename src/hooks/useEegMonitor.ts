import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import {
  MUSE_SAMPLE_RATE,
  computePsd,
  makeEegFilter,
  signalQuality,
  type FilterChain,
  type SignalQuality,
} from "@/lib/eeg/dsp";
import {
  MUSE_CHANNELS,
  MuseClient,
  SimulatedSource,
  type EegSource,
  type MuseChannel,
} from "@/lib/eeg/muse";

export type MonitorStatus = "idle" | "connecting" | "streaming" | "reconnecting" | "error";
export type SourceKind = "muse" | "simulated";

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

/** Muse 2 electrode groupings by hemisphere. */
export const LEFT_CHANNELS: MuseChannel[] = ["TP9", "AF7"];
export const RIGHT_CHANNELS: MuseChannel[] = ["AF8", "TP10"];

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
}

export interface HemiLatest {
  left: HemiMetrics;
  right: HemiMetrics;
}

function compactHemi(list: HemiSpectra[]): HemiSpectra[] {
  if (list.length <= MAX_EPOCHS) return list;
  const keepFrom = list.length - FULL_RES_EPOCHS;
  const older = list.slice(0, keepFrom).filter((_, i) => i % 2 === 0);
  return [...older, ...list.slice(keepFrom)];
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

/** dB spectrum over the DSA frequency range, matching Epoch.spectrum. */
function dsaSpectrum(signal: Float64Array): number[] {
  const psd = computePsd(signal, MUSE_SAMPLE_RATE);
  const out: number[] = [];
  for (let k = 0; k < psd.freqs.length; k++) {
    const f = psd.freqs[k]!;
    if (f < DSA_MIN_HZ) continue;
    if (f > DSA_MAX_HZ) break;
    out.push(10 * Math.log10(Math.max(psd.power[k]!, 1e-6)));
  }
  return out;
}

function readLast(buffer: ChannelBuffer, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const idx = (buffer.write - n + i + BUFFER_LEN * 2) % BUFFER_LEN;
    out[i] = buffer.data[idx]!;
  }
  return out;
}

export function useEegMonitor() {
  const [status, setStatus] = useState<MonitorStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string>("");
  const [channel, setChannel] = useState<MuseChannel | "average">("average");
  const [settings, setSettings] = useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [epochs, setEpochs] = useState<Epoch[]>([]);
  const [hemiSpectra, setHemiSpectra] = useState<HemiSpectra[]>([]);
  const [hemiLatest, setHemiLatest] = useState<HemiLatest | null>(null);
  const [events, setEvents] = useState<DetectedEvent[]>([]);
  const [waveform, setWaveform] = useState<Float64Array>(new Float64Array(0));
  const [elapsed, setElapsed] = useState(0);
  const [contactOk, setContactOk] = useState<Record<string, boolean>>({});
  const [channelQuality, setChannelQuality] = useState<Record<string, SignalQuality>>({});
  const [reconnectAttempt, setReconnectAttempt] = useState<{
    attempt: number;
    attempts: number;
  } | null>(null);
  const [dataGapSeconds, setDataGapSeconds] = useState(0);

  const buffersRef = useRef<Record<string, ChannelBuffer>>({});
  const sourceRef = useRef<EegSource | null>(null);
  const analyzerRef = useRef(new EegAnalyzer(DEFAULT_SETTINGS));
  const leftAnalyzerRef = useRef(new EegAnalyzer(DEFAULT_SETTINGS));
  const rightAnalyzerRef = useRef(new EegAnalyzer(DEFAULT_SETTINGS));
  const startedAtRef = useRef<number>(0);
  const lastSampleAtRef = useRef<number>(0);
  const gapStartRef = useRef<number | null>(null);
  const manualEventsRef = useRef<DetectedEvent[]>([]);
  const channelRef = useRef(channel);
  channelRef.current = channel;

  if (Object.keys(buffersRef.current).length === 0) {
    for (const c of MUSE_CHANNELS) buffersRef.current[c] = makeBuffer();
  }

  useEffect(() => {
    analyzerRef.current.updateSettings(settings);
    leftAnalyzerRef.current.updateSettings(settings);
    rightAnalyzerRef.current.updateSettings(settings);
  }, [settings]);

  const activeSignal = useCallback((length: number): Float64Array => {
    const sel = channelRef.current;
    if (sel !== "average") return readLast(buffersRef.current[sel]!, length);
    const out = new Float64Array(length);
    for (const c of MUSE_CHANNELS) {
      const seg = readLast(buffersRef.current[c]!, length);
      for (let i = 0; i < length; i++) out[i] = out[i]! + seg[i]! / MUSE_CHANNELS.length;
    }
    return out;
  }, []);

  /** Mean of the given electrodes, used for the per-hemisphere DSAs. */
  const groupSignal = useCallback((group: MuseChannel[], length: number): Float64Array => {
    const out = new Float64Array(length);
    for (const c of group) {
      const seg = readLast(buffersRef.current[c]!, length);
      for (let i = 0; i < length; i++) out[i] = out[i]! + seg[i]! / group.length;
    }
    return out;
  }, []);

  const stop = useCallback(async () => {
    await sourceRef.current?.stop();
    sourceRef.current = null;
    setReconnectAttempt(null);
    setStatus("idle");
  }, []);

  const reset = useCallback(() => {
    analyzerRef.current.reset();
    leftAnalyzerRef.current.reset();
    rightAnalyzerRef.current.reset();
    manualEventsRef.current = [];
    setEpochs([]);
    setHemiSpectra([]);
    setHemiLatest(null);
    setEvents([]);
    setElapsed(0);
    setDataGapSeconds(0);
    gapStartRef.current = null;
    startedAtRef.current = Date.now();
    for (const c of MUSE_CHANNELS) buffersRef.current[c] = makeBuffer();
  }, []);

  /** Appends a clinician annotation or audit entry to the session event log. */
  const addEvent = useCallback((event: DetectedEvent) => {
    manualEventsRef.current = [...manualEventsRef.current, event];
    setEvents([...analyzerRef.current.events, ...manualEventsRef.current]);
  }, []);

  const connect = useCallback(
    async (kind: SourceKind, options?: { preserveTimeline?: boolean }) => {
      setError(null);
      setStatus("connecting");
      try {
        const source: EegSource = kind === "muse" ? new MuseClient() : new SimulatedSource();
        source.onDisconnect(() => {
          setStatus("idle");
          setReconnectAttempt(null);
          setError("The headband disconnected and could not be recovered.");
        });
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
          for (let i = 0; i < samples.length; i++) {
            buf.data[buf.write] = buf.filter.process(samples[i]!);
            buf.write = (buf.write + 1) % BUFFER_LEN;
            if (buf.count < BUFFER_LEN) buf.count++;
          }
        });
        sourceRef.current = source;
        setSourceName(source.name);
        if (!options?.preserveTimeline) reset();
        lastSampleAtRef.current = Date.now();
        setStatus("streaming");
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Could not connect to the headband.");
      }
    },
    [reset],
  );

  // Epoch analysis loop.
  useEffect(() => {
    if (status !== "streaming" && status !== "reconnecting") return;
    const id = setInterval(() => {
      const anyBuffer = buffersRef.current[MUSE_CHANNELS[0]]!;
      if (anyBuffer.count < EPOCH_LEN) return;
      const t = (Date.now() - startedAtRef.current) / 1000;

      // No fresh samples: leave a real gap in the trend rather than
      // re-analysing stale buffer contents.
      if (Date.now() - lastSampleAtRef.current > STALE_SAMPLE_MS) {
        if (gapStartRef.current == null) gapStartRef.current = t;
        setDataGapSeconds(t - gapStartRef.current);
        setElapsed(t);
        return;
      }
      if (gapStartRef.current != null) {
        const gap = t - gapStartRef.current;
        gapStartRef.current = null;
        setDataGapSeconds(0);
        if (gap >= 3) {
          manualEventsRef.current = [
            ...manualEventsRef.current,
            {
              kind: "signal_quality",
              severity: "warning",
              t: t - gap,
              duration: gap,
              detail: `No EEG received for ${Math.round(gap)} s — trend gap.`,
            },
          ];
        }
      }

      const epoch = analyzerRef.current.analyze(activeSignal(EPOCH_LEN), t);
      setElapsed(t);
      setEpochs((prev) => compactEpochs([...prev, epoch]));
      const hemi: HemiSpectra = {
        left: dsaSpectrum(groupSignal(LEFT_CHANNELS, EPOCH_LEN)),
        right: dsaSpectrum(groupSignal(RIGHT_CHANNELS, EPOCH_LEN)),
      };
      setHemiSpectra((prev) => compactHemi([...prev, hemi]));
      setEvents([...analyzerRef.current.events, ...manualEventsRef.current]);

      const contact: Record<string, boolean> = {};
      const quality: Record<string, SignalQuality> = {};
      for (const c of MUSE_CHANNELS) {
        const seg = readLast(buffersRef.current[c]!, MUSE_SAMPLE_RATE * 2);
        const q = signalQuality(seg, computePsd(seg, MUSE_SAMPLE_RATE), MUSE_SAMPLE_RATE);
        quality[c] = q;
        contact[c] = !q.flat && q.grade !== "poor";
      }
      setContactOk(contact);
      setChannelQuality(quality);
    }, HOP_SECONDS * 1000);
    return () => clearInterval(id);
  }, [status, activeSignal, groupSignal]);

  // Waveform refresh.
  useEffect(() => {
    if (status !== "streaming" && status !== "reconnecting") return;
    const id = setInterval(() => {
      setWaveform(activeSignal(MUSE_SAMPLE_RATE * 4));
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
    const meanSr = epochs.reduce((a, e) => a + e.epochSuppression, 0) / epochs.length * 100;
    const maxSr = epochs.reduce((a, e) => Math.max(a, e.suppressionRatio), 0);
    return {
      meanSr,
      maxSr,
      suppressionSeconds: analyzerRef.current.suppressionSeconds,
      seizureAlerts: events.filter((e) => e.kind === "seizure").length,
      meanQuality: epochs.reduce((a, e) => a + e.quality.score, 0) / epochs.length,
      usableFraction:
        epochs.filter((e) => e.quality.grade !== "poor").length / epochs.length,
    };
  }, [epochs, events]);

  return {
    status,
    error,
    sourceName,
    channel,
    setChannel,
    settings,
    setSettings,
    epochs,
    hemiSpectra,
    events,
    latest,
    waveform,
    elapsed,
    contactOk,
    channelQuality,
    summary,
    reconnectAttempt,
    dataGapSeconds,
    addEvent,
    connect,
    stop,
    reset,
  };
}