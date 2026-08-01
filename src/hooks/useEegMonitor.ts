import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_SETTINGS,
  EPOCH_SECONDS,
  EegAnalyzer,
  HOP_SECONDS,
  type AnalysisSettings,
  type DetectedEvent,
  type Epoch,
} from "@/lib/eeg/analysis";
import { MUSE_SAMPLE_RATE, makeEegFilter, type FilterChain } from "@/lib/eeg/dsp";
import {
  MUSE_CHANNELS,
  MuseClient,
  SimulatedSource,
  type EegSource,
  type MuseChannel,
} from "@/lib/eeg/muse";

export type MonitorStatus = "idle" | "connecting" | "streaming" | "error";
export type SourceKind = "muse" | "simulated";

const BUFFER_SECONDS = 8;
const BUFFER_LEN = MUSE_SAMPLE_RATE * BUFFER_SECONDS;
const EPOCH_LEN = MUSE_SAMPLE_RATE * EPOCH_SECONDS;
const MAX_EPOCHS = 3600; // one hour of DSA at 1 Hz

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

export function useEegMonitor() {
  const [status, setStatus] = useState<MonitorStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string>("");
  const [channel, setChannel] = useState<MuseChannel | "average">("average");
  const [settings, setSettings] = useState<AnalysisSettings>(DEFAULT_SETTINGS);
  const [epochs, setEpochs] = useState<Epoch[]>([]);
  const [events, setEvents] = useState<DetectedEvent[]>([]);
  const [waveform, setWaveform] = useState<Float64Array>(new Float64Array(0));
  const [elapsed, setElapsed] = useState(0);
  const [contactOk, setContactOk] = useState<Record<string, boolean>>({});

  const buffersRef = useRef<Record<string, ChannelBuffer>>({});
  const sourceRef = useRef<EegSource | null>(null);
  const analyzerRef = useRef(new EegAnalyzer(DEFAULT_SETTINGS));
  const startedAtRef = useRef<number>(0);
  const channelRef = useRef(channel);
  channelRef.current = channel;

  if (Object.keys(buffersRef.current).length === 0) {
    for (const c of MUSE_CHANNELS) buffersRef.current[c] = makeBuffer();
  }

  useEffect(() => {
    analyzerRef.current.updateSettings(settings);
  }, [settings]);

  const activeSignal = useCallback((length: number): Float64Array => {
    const sel = channelRef.current;
    if (sel !== "average") return readLast(buffersRef.current[sel]!, length);
    const out = new Float64Array(length);
    for (const c of MUSE_CHANNELS) {
      const seg = readLast(buffersRef.current[c]!, length);
      for (let i = 0; i < length; i++) out[i] += seg[i]! / MUSE_CHANNELS.length;
    }
    return out;
  }, []);

  const stop = useCallback(async () => {
    await sourceRef.current?.stop();
    sourceRef.current = null;
    setStatus("idle");
  }, []);

  const reset = useCallback(() => {
    analyzerRef.current.reset();
    setEpochs([]);
    setEvents([]);
    setElapsed(0);
    startedAtRef.current = Date.now();
    for (const c of MUSE_CHANNELS) buffersRef.current[c] = makeBuffer();
  }, []);

  const connect = useCallback(
    async (kind: SourceKind) => {
      setError(null);
      setStatus("connecting");
      try {
        const source: EegSource = kind === "muse" ? new MuseClient() : new SimulatedSource();
        source.onDisconnect(() => {
          setStatus("idle");
          setError("The headband disconnected.");
        });
        await source.start((ch, samples) => {
          const buf = buffersRef.current[ch];
          if (!buf) return;
          for (let i = 0; i < samples.length; i++) {
            buf.data[buf.write] = buf.filter.process(samples[i]!);
            buf.write = (buf.write + 1) % BUFFER_LEN;
            if (buf.count < BUFFER_LEN) buf.count++;
          }
        });
        sourceRef.current = source;
        setSourceName(source.name);
        reset();
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
    if (status !== "streaming") return;
    const id = setInterval(() => {
      const anyBuffer = buffersRef.current[MUSE_CHANNELS[0]]!;
      if (anyBuffer.count < EPOCH_LEN) return;
      const t = (Date.now() - startedAtRef.current) / 1000;
      const epoch = analyzerRef.current.analyze(activeSignal(EPOCH_LEN), t);
      setElapsed(t);
      setEpochs((prev) => {
        const next = [...prev, epoch];
        return next.length > MAX_EPOCHS ? next.slice(next.length - MAX_EPOCHS) : next;
      });
      setEvents([...analyzerRef.current.events]);

      const contact: Record<string, boolean> = {};
      for (const c of MUSE_CHANNELS) {
        const seg = readLast(buffersRef.current[c]!, MUSE_SAMPLE_RATE);
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < seg.length; i++) {
          if (seg[i]! < min) min = seg[i]!;
          if (seg[i]! > max) max = seg[i]!;
        }
        const p2p = max - min;
        contact[c] = p2p > 0.5 && p2p < 400;
      }
      setContactOk(contact);
    }, HOP_SECONDS * 1000);
    return () => clearInterval(id);
  }, [status, activeSignal]);

  // Waveform refresh.
  useEffect(() => {
    if (status !== "streaming") return;
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
      return { meanSr: 0, maxSr: 0, suppressionSeconds: 0, seizureAlerts: 0 };
    }
    const meanSr = epochs.reduce((a, e) => a + e.epochSuppression, 0) / epochs.length * 100;
    const maxSr = epochs.reduce((a, e) => Math.max(a, e.suppressionRatio), 0);
    return {
      meanSr,
      maxSr,
      suppressionSeconds: analyzerRef.current.suppressionSeconds,
      seizureAlerts: events.filter((e) => e.kind === "seizure").length,
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
    events,
    latest,
    waveform,
    elapsed,
    contactOk,
    summary,
    connect,
    stop,
    reset,
  };
}