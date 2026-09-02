/**
 * macOS CoreBluetooth bridge client.
 *
 * Web Bluetooth cannot ask the OS for a bonded, encrypted link, and the
 * FocusCalm / Regul8 FC-11 firmware closes the connection when vendor CMSN
 * commands arrive over an unencrypted one. `bridge/macos/MindGuardBridge.swift`
 * owns the radio through CoreBluetooth instead, runs the verified handshake and
 * republishes decoded microvolts on a localhost WebSocket. This module consumes
 * that stream as an ordinary `EegSource`, so every downstream metric (DSA,
 * SEF95, suppression, COEBIS) is unchanged and unaware of the transport.
 *
 * Wire protocol (one JSON object per text message, bridge -> app):
 *   hello   { device, firmware, channels: string[], sampleRate, unit }
 *   samples { seq?, channels: Record<string, number[]> }   // already µV
 *   battery { percent }
 *   status  { state: "scanning"|"connected"|"reconnecting"|"lost", reason }
 *   log     { level, message }
 */

import {
  ANALYSIS_CHANNELS,
  profileFromChannelMap,
  type AnalysisChannel,
  type DeviceProfile,
} from "@/lib/eeg/device-profile";
import { IngestPipeline, type ChannelMap, type IngestConfig } from "@/lib/eeg/ingest";
import type {
  BatteryHandler,
  EegSource,
  SampleHandler,
  SourceState,
  SourceStateHandler,
} from "@/lib/eeg/muse";

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8787";

/** How long the bridge may stay silent after `hello` before we call it stalled. */
const BRIDGE_STALL_MS = 12_000;

export interface BridgeHello {
  device: string;
  firmware: string;
  channels: AnalysisChannel[];
  sampleRate: number;
  unit: string;
}

export interface BridgeLogLine {
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

function isAnalysisChannel(value: unknown): value is AnalysisChannel {
  return typeof value === "string" && (ANALYSIS_CHANNELS as readonly string[]).includes(value);
}

/** Validates a `hello` frame; anything malformed is treated as no hello at all. */
export function parseBridgeHello(message: unknown): BridgeHello | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record['type'] !== "hello") return null;
  const channels = Array.isArray(record['channels']) ? record['channels'].filter(isAnalysisChannel) : [];
  const sampleRate = Number(record['sampleRate']);
  if (channels.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  return {
    device: typeof record['device'] === "string" ? record['device'] : "Headband",
    firmware: typeof record['firmware'] === "string" ? record['firmware'] : "unknown",
    channels,
    sampleRate,
    unit: typeof record['unit'] === "string" ? record['unit'] : "uV",
  };
}

/** Extracts the per-channel microvolt arrays from a `samples` frame. */
export function parseBridgeSamples(message: unknown): Record<string, number[]> | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record['type'] !== "samples" || !record['channels'] || typeof record['channels'] !== "object") {
    return null;
  }
  const out: Record<string, number[]> = {};
  for (const [channel, values] of Object.entries(record['channels'] as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue;
    out[channel] = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
  }
  return Object.keys(out).length ? out : null;
}

/** Builds the ingest configuration a hello frame implies. */
export function bridgeIngestConfig(hello: BridgeHello): IngestConfig {
  const channelMap = { TP9: null, AF7: null, AF8: null, TP10: null } as ChannelMap;
  for (const channel of hello.channels) channelMap[channel] = channel;
  return {
    sampleRate: hello.sampleRate,
    // The bridge converts ADC counts to microvolts before sending, so the app
    // never has to know the front-end gain.
    unit: "uV",
    channelMap,
    label: hello.device,
  };
}

export function bridgeProfile(hello: BridgeHello): DeviceProfile {
  return profileFromChannelMap({
    label: `${hello.device} (macOS bridge)`,
    sampleRate: hello.sampleRate,
    map: bridgeIngestConfig(hello).channelMap,
  });
}

export interface MacBridgeOptions {
  url?: string;
  /** Injectable for tests. */
  socketFactory?: (url: string) => WebSocket;
  onHello?: (hello: BridgeHello) => void;
  onLog?: (line: BridgeLogLine) => void;
  /** Injectable clock/timer plumbing for tests. */
  now?: () => number;
}

/**
 * Streams a headband that is owned by the macOS bridge process. The bridge does
 * its own BLE reconnection, so this source only has to survive the WebSocket
 * going away and report honestly when the link is silent.
 */
export class MacBridgeSource implements EegSource {
  readonly name: string;
  profile?: DeviceProfile;

  private socket: WebSocket | null = null;
  private pipeline: IngestPipeline | null = null;
  private samplesCb: SampleHandler | null = null;
  private stateCb: SourceStateHandler | null = null;
  private batteryCb: BatteryHandler | null = null;
  private disconnectCb: (() => void) | null = null;
  private stopping = false;
  private stall: ReturnType<typeof setInterval> | null = null;
  private lastDataAt = 0;
  private hello: BridgeHello | null = null;
  private profileCb: ((profile: DeviceProfile) => void) | null = null;

  constructor(private readonly options: MacBridgeOptions = {}) {
    this.name = "Headband via macOS bridge";
  }

  private get url() {
    return this.options.url ?? DEFAULT_BRIDGE_URL;
  }

  private get now() {
    return this.options.now ?? (() => Date.now());
  }

  onDisconnect(cb: () => void) {
    this.disconnectCb = cb;
  }

  onState(cb: SourceStateHandler) {
    this.stateCb = cb;
  }

  onBattery(cb: BatteryHandler) {
    this.batteryCb = cb;
  }

  async start(onSamples: SampleHandler) {
    this.stopping = false;
    this.samplesCb = onSamples;
    await this.open();
    this.startStallWatchdog();
  }

  private async open() {
    const factory = this.options.socketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `The macOS bridge did not answer at ${this.url}. Start it with “swift bridge/macos/MindGuardBridge.swift”.`,
            ),
          ),
        8000,
      );
      socket.onopen = () => {
        clearTimeout(timeout);
        this.lastDataAt = this.now();
        this.emitState({ kind: "connected" });
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Could not reach the macOS bridge at ${this.url}.`));
      };
    });
    socket.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
    socket.onclose = () => {
      if (this.stopping) return;
      this.emitState({ kind: "lost", reason: "The macOS bridge closed the connection." });
      this.disconnectCb?.();
    };
  }

  private handleMessage(data: unknown) {
    if (typeof data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const type = (message as { type?: unknown } | null)?.type;

    const hello = parseBridgeHello(message);
    if (hello) {
      this.hello = hello;
      this.profile = bridgeProfile(hello);
      this.pipeline = new IngestPipeline(bridgeIngestConfig(hello), (channel, samples) =>
        this.samplesCb?.(channel, samples),
      );
      this.lastDataAt = this.now();
      this.options.onHello?.(hello);
      return;
    }

    const frame = parseBridgeSamples(message);
    if (frame) {
      // Samples before hello cannot be mapped onto electrodes; drop them rather
      // than guess a montage.
      if (!this.pipeline) return;
      this.lastDataAt = this.now();
      this.pipeline.push(frame);
      return;
    }

    if (type === "battery") {
      const percent = Number((message as { percent?: unknown }).percent);
      if (Number.isFinite(percent)) this.batteryCb?.(Math.max(0, Math.min(100, percent)));
      return;
    }

    if (type === "status") {
      const record = message as { state?: unknown; reason?: unknown };
      const reason = typeof record.reason === "string" ? record.reason : "";
      if (record.state === "reconnecting") {
        this.emitState({ kind: "reconnecting", attempt: 1, attempts: 1 });
      } else if (record.state === "lost") {
        this.emitState({ kind: "lost", reason: reason || "The headband disconnected." });
      } else if (record.state === "connected") {
        this.emitState({ kind: "connected" });
      }
      return;
    }

    if (type === "log") {
      const record = message as { level?: unknown; message?: unknown };
      const level =
        record.level === "warn" || record.level === "error" ? record.level : ("info" as const);
      this.options.onLog?.({
        level,
        message: typeof record.message === "string" ? record.message : "",
        at: this.now(),
      });
    }
  }

  /** A bridge that is connected but silent must never look healthy. */
  private startStallWatchdog() {
    this.stopStallWatchdog();
    this.stall = setInterval(() => {
      if (this.stopping || !this.socket) return;
      if (this.now() - this.lastDataAt <= BRIDGE_STALL_MS) return;
      this.emitState({
        kind: "lost",
        reason: "The bridge is connected but no EEG has arrived — check the headband.",
      });
      this.lastDataAt = this.now();
    }, 2000);
  }

  private stopStallWatchdog() {
    if (this.stall) clearInterval(this.stall);
    this.stall = null;
  }

  private emitState(state: SourceState) {
    this.stateCb?.(state);
  }

  /** Clinician-triggered retry: re-open the WebSocket, the bridge keeps the BLE link. */
  async reconnect(): Promise<boolean> {
    if (this.stopping || !this.samplesCb) return false;
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    try {
      await this.open();
      return true;
    } catch {
      return false;
    }
  }

  describe(): BridgeHello | null {
    return this.hello;
  }

  async stop() {
    this.stopping = true;
    this.stopStallWatchdog();
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.pipeline = null;
    this.samplesCb = null;
  }
}
