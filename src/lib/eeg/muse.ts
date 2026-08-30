/// <reference types="web-bluetooth" />
/**
 * Muse 2 (and Muse S / Muse 2016) Web Bluetooth client.
 * Streams the four scalp electrodes at 256 Hz.
 */

import {
  ANALYSIS_CHANNELS,
  MUSE_2_PROFILE,
  SIMULATED_PROFILE,
  type AnalysisChannel,
} from "@/lib/eeg/device-profile";
import {
  acquireScreenWakeLock,
  createBackgroundTimer,
  onForeground,
  type BackgroundTimer,
  type WakeLockHandle,
} from "@/lib/eeg/keep-awake";

export const MUSE_SERVICE = "0000fe8d-0000-1000-8000-00805f9b34fb";
const CONTROL_CHAR = "273e0001-4c4d-454d-96be-f03bac821358";

/**
 * The canonical analysis positions live in device-profile.ts, which is the
 * device-agnostic definition; these aliases keep the historical names working
 * for existing recordings and imports.
 */
export const MUSE_CHANNELS = ANALYSIS_CHANNELS;
export type MuseChannel = AnalysisChannel;

const EEG_CHARS: Record<MuseChannel, string> = {
  TP9: "273e0003-4c4d-454d-96be-f03bac821358",
  AF7: "273e0004-4c4d-454d-96be-f03bac821358",
  AF8: "273e0005-4c4d-454d-96be-f03bac821358",
  TP10: "273e0006-4c4d-454d-96be-f03bac821358",
};

export type SampleHandler = (channel: MuseChannel, samples: Float64Array) => void;

/** A Muse streaming preset the clinician can confirm before the case starts. */
export interface MusePreset {
  /** Control command, e.g. "p21". */
  code: string;
  label: string;
  detail: string;
  channels: number;
  sampleRate: number;
  /** Presets that only exist on later firmware / Muse S hardware. */
  requiresMuseS?: boolean;
}

/**
 * Only presets that keep the four scalp electrodes at 256 Hz are offered —
 * every downstream metric (DSA, SEF95, suppression ratio, depth index)
 * assumes that geometry.
 */
export const MUSE_PRESETS: MusePreset[] = [
  {
    code: "p21",
    label: "4-channel EEG (256 Hz)",
    detail: "TP9, AF7, AF8, TP10 only. Lowest bandwidth and the most robust link.",
    channels: 4,
    sampleRate: 256,
  },
  {
    code: "p20",
    label: "4-channel EEG + AUX (256 Hz)",
    detail: "Adds the auxiliary electrode channel; unused by the analysis but harmless.",
    channels: 5,
    sampleRate: 256,
  },
  {
    code: "p50",
    label: "Muse S: EEG + PPG (256 Hz)",
    detail: "Muse S firmware only. Keeps the four scalp electrodes and enables PPG.",
    channels: 4,
    sampleRate: 256,
    requiresMuseS: true,
  },
];

export const DEFAULT_MUSE_PRESET = "p21";

/** One reason a chosen streaming mode cannot (or should not) be used. */
export interface StreamingIssue {
  severity: "blocker" | "warning";
  title: string;
  detail: string;
  /** Plain-language remedy shown to the clinician. */
  fix: string;
  /** Preset to switch to when the remedy is a one-click change. */
  suggestedPreset?: string;
}

export interface StreamingValidation {
  status: "ok" | "warning" | "blocked";
  issues: StreamingIssue[];
}

/** What the headband reported about itself before streaming was confirmed. */
export interface MuseCapabilities {
  deviceName: string;
  /** e.g. "Muse-2" / "Muse-S", derived from the advertised name or hardware id. */
  model: string;
  firmwareVersion: string | null;
  hardwareVersion: string | null;
  buildNumber: string | null;
  protocolVersion: string | null;
  batteryPercent: number | null;
  /** Presets this headband can be asked for. */
  presets: MusePreset[];
  recommendedPreset: string;
  /** Raw control-channel replies, useful when a headband answers unexpectedly. */
  raw: Record<string, unknown>;
}

/** Connection lifecycle reported to the UI so a dropout is never silent. */
export type SourceState =
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number; attempts: number }
  | { kind: "lost"; reason: string };

export type SourceStateHandler = (state: SourceState) => void;

/** Battery charge reported by the headband, 0–100. */
export type BatteryHandler = (percent: number) => void;

export interface EegSource {
  readonly name: string;
  /**
   * What this source actually provides — populated electrodes, hemispheres
   * and native sample rate. Sources that omit it are treated as the default
   * four-electrode 256 Hz montage.
   */
  readonly profile?: import("@/lib/eeg/device-profile").DeviceProfile;
  start(onSamples: SampleHandler): Promise<void>;
  stop(): Promise<void>;
  onDisconnect(cb: () => void): void;
  /** Optional: reports reconnection attempts while the case continues. */
  onState?(cb: SourceStateHandler): void;
  /** Optional: reports the headband's battery charge while streaming. */
  onBattery?(cb: BatteryHandler): void;
  /**
   * Optional: clinician-triggered retry after the automatic attempts gave up.
   * Resolves true when the link is back; the case and its data are untouched.
   */
  reconnect?(): Promise<boolean>;
}

export function isWebBluetoothAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "bluetooth" in navigator &&
    typeof navigator.bluetooth?.requestDevice === "function"
  );
}

/** Human-readable guidance shown when the browser cannot do Web Bluetooth. */
export const WEB_BLUETOOTH_HELP =
  "Web Bluetooth is unavailable in this browser. On desktop or Android use Chrome or Edge; on iPhone or iPad open this app in Bluefy (or another Web BLE browser).";

/**
 * Some Web Bluetooth implementations — notably Bluefy on iOS — do not always
 * surface a Muse through a namePrefix filter (iOS hides the advertised name
 * until the device is bonded). Fall back to the full chooser, still scoped to
 * the Muse GATT service, so the headband can be picked manually.
 */
export async function requestMuseDevice(): Promise<BluetoothDevice> {
  if (!isWebBluetoothAvailable()) throw new Error(WEB_BLUETOOTH_HELP);
  try {
    return await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Muse" }, { services: [MUSE_SERVICE] }],
      optionalServices: [MUSE_SERVICE],
    });
  } catch (error) {
    // NotFoundError covers both "nothing matched" and "user cancelled"; only
    // retry for the former, otherwise cancelling would reopen the chooser.
    const cancelled = /cancel/i.test((error as Error)?.message ?? "");
    if (error instanceof DOMException && error.name === "NotFoundError" && !cancelled) {
      return await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [MUSE_SERVICE],
      });
    }
    throw error;
  }
}

/**
 * The control characteristic answers in fragments: each notification is a
 * length-prefixed ASCII chunk, and a reply is complete once the accumulated
 * text parses as JSON.
 */
export function decodeControlChunk(data: DataView): string {
  const length = Math.min(data.getUint8(0), data.byteLength - 1);
  let text = "";
  for (let i = 1; i <= length; i++) text += String.fromCharCode(data.getUint8(i));
  return text;
}

function inferModel(name: string, hardware: string | null): string {
  const source = `${name} ${hardware ?? ""}`.toLowerCase();
  if (source.includes("muses") || /muse[-\s]?s/.test(source)) return "Muse S";
  if (source.includes("2016")) return "Muse 2016";
  if (source.includes("muse")) return "Muse 2";
  return name || "Unknown headband";
}

/**
 * Opens the headband, asks it who it is (`v1`) and how it is doing (`s`), then
 * leaves the GATT link open so the confirmed configuration can start streaming
 * without a second pairing prompt.
 */
export async function probeMuseDevice(device: BluetoothDevice): Promise<MuseCapabilities> {
  const server = await device.gatt!.connect();
  const service = await server.getPrimaryService(MUSE_SERVICE);
  const control = await service.getCharacteristic(CONTROL_CHAR);
  await control.startNotifications();

  let buffer = "";
  const replies: Record<string, unknown>[] = [];
  const onValue = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value || value.byteLength === 0) return;
    buffer += decodeControlChunk(value);
    const end = buffer.lastIndexOf("}");
    if (end === -1) return;
    const start = buffer.indexOf("{");
    if (start === -1) return;
    try {
      replies.push(JSON.parse(buffer.slice(start, end + 1)) as Record<string, unknown>);
      buffer = buffer.slice(end + 1);
    } catch {
      /* still incomplete */
    }
  };
  control.addEventListener("characteristicvaluechanged", onValue);

  const send = async (command: string) => {
    const encoded = new Uint8Array(command.length + 2);
    encoded[0] = command.length + 1;
    for (let i = 0; i < command.length; i++) encoded[i + 1] = command.charCodeAt(i);
    encoded[command.length + 1] = 0x0a;
    await control.writeValue(encoded);
  };

  try {
    await send("h"); // make sure nothing is streaming while we ask questions
    await send("v1"); // firmware / hardware identity
    await send("s"); // status: battery, preset, serial
    // Give the headband time to answer both queries.
    await new Promise((r) => setTimeout(r, 1200));
  } finally {
    control.removeEventListener("characteristicvaluechanged", onValue);
    try {
      await control.stopNotifications();
    } catch {
      /* link may already be closing */
    }
  }

  const merged: Record<string, unknown> = Object.assign({}, ...replies);
  const str = (key: string): string | null => {
    const value = merged[key];
    return value === undefined || value === null ? null : String(value);
  };
  const name = device.name ?? "Muse";
  const hardware = str("hw");
  const model = inferModel(name, hardware);
  const battery = Number(merged["bp"]);
  const presets = MUSE_PRESETS.filter((p) => !p.requiresMuseS || model === "Muse S");

  return {
    deviceName: name,
    model,
    // Only the firmware field is a firmware version. The build number ("bn")
    // is an unrelated counter and must never be read as a version, or an
    // up-to-date headband can look ancient.
    firmwareVersion: str("fw"),
    hardwareVersion: hardware,
    buildNumber: str("bn"),
    protocolVersion: str("pv"),
    batteryPercent: Number.isFinite(battery) ? Math.round(battery) : null,
    presets,
    recommendedPreset: DEFAULT_MUSE_PRESET,
    raw: merged,
  };
}

/** Muse packets carry 12 samples packed as 12-bit unsigned integers. */
export function decodeMusePacket(data: DataView): Float64Array {
  const out = new Float64Array(12);
  let bitOffset = 16; // first 16 bits are the packet index
  // The 12 packed samples end exactly on the 20th byte, so the third byte of
  // the final read is past the buffer: treat missing bytes as zero.
  const at = (i: number) => (i < data.byteLength ? data.getUint8(i) : 0);
  for (let i = 0; i < 12; i++) {
    const byte = bitOffset >> 3;
    const shift = bitOffset & 7;
    const raw = (((at(byte) << 16) | (at(byte + 1) << 8) | at(byte + 2)) >> (12 - shift)) & 0xfff;
    // 0.48828125 µV per LSB, centred on 2048.
    out[i] = 0.48828125 * (raw - 2048);
    bitOffset += 12;
  }
  return out;
}

/**
 * Extracts a comparable numeric version from strings like "1.2.13" or
 * "fw 1.2". A bare number (a build counter, a date) is NOT a version — those
 * return null so the headband is never judged on a misread string.
 */
export function parseFirmwareVersion(value: string | null): number[] | null {
  if (!value) return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function isOlderThan(version: number[], minimum: number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    const a = version[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * Muse firmware families differ between hardware revisions (a fully updated
 * Muse 2016 sits well below a current Muse 2), so only genuinely pre-release
 * firmware is called out — and only as a warning, never a blocker. Interop
 * problems surface during the streaming handshake, not from a version string.
 */
const MIN_FIRMWARE = [1, 0, 0];

/**
 * Checks the chosen streaming mode against what the headband actually
 * reported, so a case never starts on a configuration the device cannot
 * deliver. Every blocker carries a concrete remedy.
 */
export function validateStreamingConfig(
  caps: MuseCapabilities,
  presetCode: string,
): StreamingValidation {
  const issues: StreamingIssue[] = [];
  const known = MUSE_PRESETS.find((p) => p.code === presetCode);
  const supported = caps.presets.some((p) => p.code === presetCode);

  if (!known) {
    issues.push({
      severity: "blocker",
      title: "Unrecognised streaming mode",
      detail: `“${presetCode}” is not a mode CortexTrace knows how to analyse.`,
      fix: `Switch to ${DEFAULT_MUSE_PRESET} — four scalp electrodes at 256 Hz.`,
      suggestedPreset: DEFAULT_MUSE_PRESET,
    });
  } else if (!supported) {
    issues.push({
      severity: "blocker",
      title: "Mode not supported by this headband",
      detail: `${caps.model} did not report support for ${known.label}.`,
      fix: `Switch to ${DEFAULT_MUSE_PRESET}, which every Muse headband supports.`,
      suggestedPreset: DEFAULT_MUSE_PRESET,
    });
  }

  if (known?.requiresMuseS && caps.model !== "Muse S") {
    issues.push({
      severity: "blocker",
      title: "Muse S firmware required",
      detail: `${known.label} needs Muse S hardware; this headband reports as ${caps.model}.`,
      fix: `Switch to ${DEFAULT_MUSE_PRESET} or connect a Muse S headband.`,
      suggestedPreset: DEFAULT_MUSE_PRESET,
    });
  }

  if (known && known.channels < 4) {
    issues.push({
      severity: "blocker",
      title: "Too few electrodes",
      detail: "Bilateral DSA, suppression ratio and depth index all need four scalp electrodes.",
      fix: `Switch to ${DEFAULT_MUSE_PRESET}.`,
      suggestedPreset: DEFAULT_MUSE_PRESET,
    });
  }

  if (known && known.sampleRate < 256) {
    issues.push({
      severity: "blocker",
      title: "Sample rate too low",
      detail: `${known.sampleRate} Hz cannot resolve the beta band used by the depth index.`,
      fix: `Switch to a 256 Hz mode such as ${DEFAULT_MUSE_PRESET}.`,
      suggestedPreset: DEFAULT_MUSE_PRESET,
    });
  }

  const firmware = parseFirmwareVersion(caps.firmwareVersion);
  if (!firmware) {
    issues.push({
      severity: "warning",
      title: "Firmware not reported",
      detail: "The headband did not answer the version query, so the mode cannot be verified.",
      fix: "Re-read the headband; if it still stays silent, power-cycle it and pair again.",
    });
  } else if (isOlderThan(firmware, MIN_FIRMWARE)) {
    issues.push({
      severity: "warning",
      title: "Unusually old firmware",
      detail: `The headband reports firmware ${caps.firmwareVersion}, older than any shipped Muse release (${MIN_FIRMWARE.join(".")}).`,
      fix: "Check for an update in the Muse mobile app. If it is already current, start the case — streaming is verified at handshake.",
    });
  }

  if (caps.batteryPercent != null && caps.batteryPercent < 20) {
    issues.push({
      severity: caps.batteryPercent < 10 ? "blocker" : "warning",
      title: "Battery low",
      detail: `The headband reports ${caps.batteryPercent}% charge.`,
      fix: "Charge the headband before the case, or swap to a charged one.",
    });
  }

  const status = issues.some((i) => i.severity === "blocker")
    ? "blocked"
    : issues.length > 0
      ? "warning"
      : "ok";
  return { status, issues };
}

/**
 * Picks the richest streaming mode the headband can actually deliver.
 * Candidates are ranked by channel count (AUX before plain EEG) and only
 * accepted if they clear validation; a mode whose only blockers are
 * device-level (flat battery, old firmware) cannot be fixed by switching, so
 * the recommended mode is returned instead.
 */
export function selectBestPreset(caps: MuseCapabilities): {
  preset: string;
  validation: StreamingValidation;
  /** True when no preset clears validation — the remedy is on the device. */
  deviceBlocked: boolean;
} {
  const candidates = [...caps.presets].sort((a, b) => {
    if (a.code === caps.recommendedPreset) return -1;
    if (b.code === caps.recommendedPreset) return 1;
    return b.channels - a.channels;
  });
  for (const candidate of candidates) {
    const validation = validateStreamingConfig(caps, candidate.code);
    if (validation.status !== "blocked") {
      return { preset: candidate.code, validation, deviceBlocked: false };
    }
  }
  const fallback = caps.recommendedPreset || DEFAULT_MUSE_PRESET;
  return {
    preset: fallback,
    validation: validateStreamingConfig(caps, fallback),
    deviceBlocked: true,
  };
}

export class MuseClient implements EegSource {
  name = "Muse";
  readonly profile = MUSE_2_PROFILE;
  private device: BluetoothDevice | null = null;
  private preset: string = DEFAULT_MUSE_PRESET;
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  private disconnectCb: (() => void) | null = null;
  private stateCb: SourceStateHandler | null = null;
  private batteryCb: BatteryHandler | null = null;
  /** Buffered control-characteristic text, used to read status replies. */
  private controlBuffer = "";
  private controlListener: ((event: Event) => void) | null = null;
  private lastStatusAt = 0;
  private samplesCb: SampleHandler | null = null;
  private stopping = false;
  private reconnecting = false;
  /** Live notification subscriptions, so a reconnect can detach cleanly. */
  private subscriptions: {
    characteristic: BluetoothRemoteGATTCharacteristic;
    listener: (event: Event) => void;
  }[] = [];
  /** Kept so stop() can detach it; the browser reuses BluetoothDevice objects. */
  private disconnectListener: (() => void) | null = null;
  /** Exponential backoff, seconds, between reconnection attempts. */
  private static readonly RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];
  /**
   * Muse firmware puts itself to sleep after a spell without a host command —
   * in practice around 15–20 minutes — even while it is happily streaming.
   * A periodic keep-alive ("k") holds the headband awake for the whole case.
   */
  private static readonly KEEP_ALIVE_MS = 10_000;
  /** Resend the start-data command if notifications dry up but GATT is up. */
  private static readonly STALL_NUDGE_MS = 6_000;
  /** Force a full reconnect if samples never come back after a nudge. */
  private static readonly STALL_RESET_MS = 15_000;
  /** How often the headband is asked for a status ("s") reply. */
  private static readonly BATTERY_POLL_MS = 60_000;
  /** A reconnect attempt that has not streamed by now is abandoned and retried. */
  private static readonly ATTACH_TIMEOUT_MS = 20_000;
  private heartbeat: BackgroundTimer | null = null;
  /** Screen wake lock held for the length of a case. */
  private wakeLock: WakeLockHandle | null = null;
  /** Unsubscribes the "page came back to the foreground" handler. */
  private foregroundOff: (() => void) | null = null;
  private lastSampleAt = 0;
  private nudgedAt = 0;
  /**
   * Bumped on every (re)attach and link teardown. An in-flight keep-alive that
   * started before a dropout must not write to, or judge, the new link.
   */
  private epoch = 0;
  /** Resolves the current backoff sleep early when the clinician taps Reconnect. */
  private retryWake: (() => void) | null = null;
  /** Callers waiting on the outcome of the background retry loop. */
  private linkWaiters: ((ok: boolean) => void)[] = [];
  /** True while a manual retry is waiting on the background loop's next try. */
  private manualPending = false;
  /** Bluetooth stacks need a moment to release a half-open GATT link. */
  private static readonly LINK_SETTLE_MS = 600;

  /**
   * A device and preset can be supplied when the clinician has already probed
   * and confirmed the streaming configuration; otherwise the chooser opens.
   */
  constructor(options?: { device?: BluetoothDevice; preset?: string }) {
    if (options?.device) this.device = options.device;
    if (options?.preset) this.preset = options.preset;
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

  /**
   * Status replies arrive as length-prefixed ASCII fragments on the control
   * characteristic; once a fragment completes a JSON object, read the battery
   * percentage ("bp") out of it.
   */
  private handleControlValue = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value || value.byteLength === 0) return;
    this.controlBuffer += decodeControlChunk(value);
    const end = this.controlBuffer.lastIndexOf("}");
    const start = this.controlBuffer.indexOf("{");
    if (end === -1 || start === -1 || end < start) return;
    const text = this.controlBuffer.slice(start, end + 1);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      this.controlBuffer = this.controlBuffer.slice(end + 1);
      const battery = Number(parsed["bp"]);
      if (Number.isFinite(battery)) {
        this.batteryCb?.(Math.max(0, Math.min(100, Math.round(battery))));
      }
    } catch {
      /* reply still incomplete */
    }
    // Never let a malformed reply grow without bound.
    if (this.controlBuffer.length > 2000) this.controlBuffer = "";
  };

  private async send(command: string) {
    const control = this.control;
    if (!control) return;
    const encoded = new Uint8Array(command.length + 2);
    encoded[0] = command.length + 1;
    for (let i = 0; i < command.length; i++) encoded[i + 1] = command.charCodeAt(i);
    encoded[command.length + 1] = 0x0a;
    await control.writeValue(encoded);
  }

  async start(onSamples: SampleHandler) {
    if (!isWebBluetoothAvailable()) {
      throw new Error(WEB_BLUETOOTH_HELP);
    }
    this.stopping = false;
    this.samplesCb = onSamples;
    const device = this.device ?? (await requestMuseDevice());
    this.device = device;
    this.name = device.name ?? "Muse";
    if (this.disconnectListener) {
      device.removeEventListener("gattserverdisconnected", this.disconnectListener);
    }
    this.disconnectListener = () => {
      if (this.stopping) return;
      void this.attemptReconnect();
    };
    device.addEventListener("gattserverdisconnected", this.disconnectListener);

    // A locked or dimmed screen freezes the keep-alive and lets the headband
    // idle off the link, so hold the screen awake for the length of the case.
    this.wakeLock ??= acquireScreenWakeLock();
    // Coming back to the foreground: check the link immediately rather than
    // waiting out a backoff or keep-alive interval that was throttled while
    // the page was hidden.
    this.foregroundOff ??= onForeground(() => {
      if (this.stopping) return;
      if (this.reconnecting) this.retryWake?.();
      else if (!(this.device?.gatt?.connected ?? false)) void this.attemptReconnect();
      else void this.tick();
    });

    await this.attach();
  }

  /**
   * Drops every notification listener added by a previous attach. Web
   * Bluetooth hands back the same characteristic objects across GATT
   * reconnects, so without this each dropout would add a second listener and
   * the same samples would be written to the ring buffer twice.
   */
  private detachSubscriptions() {
    this.detachOwn(this.subscriptions);
  }

  /**
   * Removes only the listeners a specific attach registered. A timed-out
   * attach can still be in flight while a newer one succeeds; it must never
   * tear down the live listeners of the attach that won.
   */
  private detachOwn(mine: { characteristic: BluetoothRemoteGATTCharacteristic; listener: (e: Event) => void }[]) {
    for (const entry of mine) {
      entry.characteristic.removeEventListener("characteristicvaluechanged", entry.listener);
    }
    this.subscriptions = this.subscriptions.filter((s) => !mine.includes(s));
    mine.length = 0;
  }

  /** (Re)opens GATT and re-subscribes to the four electrode characteristics. */
  private async attach() {
    const device = this.device;
    const onSamples = this.samplesCb;
    if (!device || !onSamples) throw new Error("The headband is no longer available.");
    this.epoch++;
    const epoch = this.epoch;
    this.detachSubscriptions();
    const mine: { characteristic: BluetoothRemoteGATTCharacteristic; listener: (e: Event) => void }[] = [];
    const server = await device.gatt!.connect();
    // stop() can land mid-handshake; abandon rather than resurrect the link.
    if (this.stopping || epoch !== this.epoch) throw new Error("Connection cancelled.");
    const service = await server.getPrimaryService(MUSE_SERVICE);
    const control = await service.getCharacteristic(CONTROL_CHAR);
    if (this.stopping || epoch !== this.epoch) throw new Error("Connection cancelled.");
    this.control = control;
    await control.startNotifications();
    control.removeEventListener("characteristicvaluechanged", this.handleControlValue);
    control.addEventListener("characteristicvaluechanged", this.handleControlValue);
    this.controlBuffer = "";

    for (const channel of MUSE_CHANNELS) {
      if (this.stopping || epoch !== this.epoch) {
        this.detachOwn(mine);
        throw new Error("Connection cancelled.");
      }
      const characteristic = await service.getCharacteristic(EEG_CHARS[channel]);
      const listener = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (value && value.byteLength >= 20) {
          this.lastSampleAt = Date.now();
          onSamples(channel, decodeMusePacket(value));
        }
      };
      characteristic.addEventListener("characteristicvaluechanged", listener);
      const entry = { characteristic, listener };
      mine.push(entry);
      this.subscriptions.push(entry);
      await characteristic.startNotifications();
    }

    if (this.stopping || epoch !== this.epoch) {
      this.detachOwn(mine);
      throw new Error("Connection cancelled.");
    }
    await this.send("h"); // halt any existing stream
    await this.send(this.preset); // confirmed streaming preset
    await this.send("s"); // status
    await this.send("d"); // start data
    if (epoch !== this.epoch) {
      this.detachOwn(mine);
      throw new Error("Connection cancelled.");
    }
    this.lastSampleAt = Date.now();
    this.lastStatusAt = Date.now();
    this.nudgedAt = 0;
    this.startHeartbeat();
  }

  /**
   * Tears a half-open link down before retrying. A GATT connect that failed
   * part-way (very common when the headband drops mid-case) leaves the browser
   * believing it is still connected, so the next `gatt.connect()` resolves
   * instantly against a dead handle and every retry fails the same way.
   */
  private async resetLink() {
    this.epoch++;
    this.control = null;
    this.controlBuffer = "";
    this.detachSubscriptions();
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, MuseClient.LINK_SETTLE_MS));
  }

  /**
   * Backoff sleep that the clinician's Reconnect tap can cut short. It runs on
   * the worker clock: a hidden tab's `setTimeout` is throttled to about a
   * minute, which would stretch the retry ladder out to nothing.
   */
  private waitForRetry(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = createBackgroundTimer(ms, () => {
        timer.stop();
        this.retryWake = null;
        resolve();
      });
      this.retryWake = () => {
        timer.stop();
        this.retryWake = null;
        resolve();
      };
    });
  }

  private settleWaiters(ok: boolean) {
    const waiters = this.linkWaiters;
    this.linkWaiters = [];
    this.manualPending = false;
    for (const waiter of waiters) waiter(ok);
  }

  /**
   * Keeps the headband awake and streaming for the length of a case: sends the
   * keep-alive the firmware expects, and recovers a silent link that Bluetooth
   * never reported as disconnected.
   *
   * The tick runs off a worker timer. A page-timer interval is throttled to
   * roughly once a minute as soon as the tab is hidden or the screen dims,
   * which is slower than the Muse idle timeout — that is exactly how a case
   * quietly dies around the twenty-minute mark.
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = createBackgroundTimer(MuseClient.KEEP_ALIVE_MS, () => {
      if (this.stopping) return;
      void this.tick();
    });
  }

  private stopHeartbeat() {
    this.heartbeat?.stop();
    this.heartbeat = null;
  }

  private async tick() {
    if (this.reconnecting) return;
    const epoch = this.epoch;
    const connected = this.device?.gatt?.connected ?? false;
    if (!connected) {
      void this.attemptReconnect();
      return;
    }
    const silentFor = Date.now() - this.lastSampleAt;
    try {
      await this.send("k"); // keep-alive: stops the firmware idling out mid-case
      if (Date.now() - this.lastStatusAt > MuseClient.BATTERY_POLL_MS) {
        this.lastStatusAt = Date.now();
        await this.send("s"); // status: refreshes the battery reading
      }
    } catch {
      if (epoch === this.epoch) void this.attemptReconnect();
      return;
    }
    // The link was rebuilt underneath this tick: its timings no longer apply.
    if (epoch !== this.epoch || this.reconnecting) return;
    if (silentFor > MuseClient.STALL_RESET_MS && this.nudgedAt) {
      // Nudged already and still nothing: drop the link so the normal
      // reconnect path rebuilds it from scratch.
      this.nudgedAt = 0;
      void this.attemptReconnect();
      return;
    }
    if (silentFor > MuseClient.STALL_NUDGE_MS && !this.nudgedAt) {
      this.nudgedAt = Date.now();
      try {
        await this.send("d"); // restart the data stream
      } catch {
        void this.attemptReconnect();
      }
      return;
    }
    if (silentFor <= MuseClient.STALL_NUDGE_MS) this.nudgedAt = 0;
  }

  /**
   * A bounded attach. Resolves as soon as the link is streaming, rejects if the
   * headband has not answered within the window so the caller can retry.
   */
  private withAttachTimeout(): Promise<void> {
    let timer: BackgroundTimer | null = null;
    const guard = new Promise<never>((_, reject) => {
      timer = createBackgroundTimer(MuseClient.ATTACH_TIMEOUT_MS, () => {
        timer?.stop();
        reject(new Error("The headband did not answer in time."));
      });
    });
    return Promise.race([this.attach(), guard]).finally(() => timer?.stop());
  }

  /**
   * Headbands slip and Bluetooth drops mid-case. Retry with backoff and keep
   * the case running; only give up — and tell the clinician — after five tries.
   */
  private async attemptReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.stopHeartbeat();
    const attempts = MuseClient.RETRY_DELAYS.length;
    let told = false;
    // Keep trying for as long as the case is running — the clinician ends the
    // case, not a retry counter.
    for (let i = 0; !this.stopping; i++) {
      this.stateCb?.({ kind: "reconnecting", attempt: Math.min(i + 1, attempts), attempts });
      const delay = MuseClient.RETRY_DELAYS[Math.min(i, attempts - 1)]!;
      await this.waitForRetry(delay);
      if (this.stopping) break;
      try {
        // Always start from a cleanly closed link, never a half-open one.
        await this.resetLink();
        if (this.stopping) break;
        // `gatt.connect()` never rejects while the headband is simply out of
        // range — it waits for an advertisement that may never come, which
        // parks the retry ladder on a single attempt forever. Bound it so the
        // loop always comes back around.
        await this.withAttachTimeout();
        this.reconnecting = false;
        this.settleWaiters(true);
        this.stateCb?.({ kind: "connected" });
        return;
      } catch {
        if (this.manualPending) this.settleWaiters(false);
        if (i + 1 >= attempts && !told) {
          told = true;
          this.stateCb?.({
            kind: "lost",
            reason:
              "The headband has not come back yet — the case and its data are kept and reconnection keeps retrying in the background. Check the headband is on and charged, or tap Reconnect.",
          });
          this.disconnectCb?.();
        }
      }
    }
    this.reconnecting = false;
    this.settleWaiters(false);
  }

  /**
   * Manual retry. The device handle and every subscription target are kept
   * after a lost link, so this re-opens GATT on the same headband without
   * ending the case or clearing anything already recorded.
   */
  async reconnect(): Promise<boolean> {
    this.stopping = false;
    if (!this.device || !this.samplesCb) return false;
    // A background retry loop is already running: don't report failure —
    // cut its backoff short and report what that attempt actually does.
    if (this.reconnecting) {
      this.manualPending = true;
      const outcome = new Promise<boolean>((resolve) => this.linkWaiters.push(resolve));
      this.stateCb?.({ kind: "reconnecting", attempt: 1, attempts: 1 });
      this.retryWake?.();
      return outcome;
    }
    this.reconnecting = true;
    this.stopHeartbeat();
    this.stateCb?.({ kind: "reconnecting", attempt: 1, attempts: 1 });
    try {
      await this.resetLink();
      await this.withAttachTimeout();
      this.reconnecting = false;
      this.stateCb?.({ kind: "connected" });
      return true;
    } catch (e) {
      this.reconnecting = false;
      this.stateCb?.({
        kind: "lost",
        reason:
          e instanceof Error
            ? `Reconnection failed: ${e.message}. If it keeps failing, power-cycle the headband and pair it again.`
            : "Reconnection failed — check the headband is on and in range.",
      });
      // Fall back to the patient background loop rather than leaving the case
      // with no link and nothing trying to restore it.
      void this.attemptReconnect();
      return false;
    }
  }

  async stop() {
    this.stopping = true;
    this.epoch++;
    this.retryWake?.();
    this.reconnecting = false;
    this.settleWaiters(false);
    this.stopHeartbeat();
    this.wakeLock?.release();
    this.wakeLock = null;
    this.foregroundOff?.();
    this.foregroundOff = null;
    this.detachSubscriptions();
    try {
      await this.send("h");
    } catch {
      /* device may already be gone */
    }
    if (this.device && this.disconnectListener) {
      this.device.removeEventListener("gattserverdisconnected", this.disconnectListener);
    }
    this.disconnectListener = null;
    this.device?.gatt?.disconnect();
    this.device = null;
    this.control = null;
    this.samplesCb = null;
  }
}

/**
 * Physiologically-shaped simulator used to rehearse the workflow without a
 * headband. Cycles through awake-ish, anaesthetised, burst-suppression and
 * rhythmic ictal-appearing states.
 */
export class SimulatedSource implements EegSource {
  name = "Simulated signal";
  readonly profile = SIMULATED_PROFILE;
  private timer: ReturnType<typeof setInterval> | null = null;
  private t = 0;

  onDisconnect() {
    /* simulator never drops out */
  }

  async start(onSamples: SampleHandler) {
    const fs = 256;
    const chunk = 12;
    this.timer = setInterval(
      () => {
        for (const channel of MUSE_CHANNELS) {
          const out = new Float64Array(chunk);
          for (let i = 0; i < chunk; i++) {
            // Time is shared across channels: the phase must depend on the
            // sample index, not on how many channels have been rendered.
            out[i] = this.sample(channel, this.t + i / fs);
          }
          onSamples(channel, out);
        }
        this.t += chunk / fs;
      },
      (chunk / fs) * 1000,
    );
  }

  private sample(channel: MuseChannel, time: number): number {
    const phase = time;
    const cycle = time % 240;
    const jitter = (Math.random() - 0.5) * 4;
    const gain = channel === "AF7" || channel === "AF8" ? 1.1 : 0.9;

    if (cycle < 60) {
      // Adequate general anaesthesia: strong slow-delta + alpha spindles.
      return (
        gain *
        (28 * Math.sin(2 * Math.PI * 1.4 * phase) +
          16 * Math.sin(2 * Math.PI * 9.5 * phase) +
          jitter)
      );
    }
    if (cycle < 120) {
      // Burst suppression: ~8 s period, 2 s bursts.
      const inBurst = time % 8 < 2;
      return inBurst
        ? gain * (60 * Math.sin(2 * Math.PI * 2.5 * phase) + jitter * 2)
        : jitter * 0.5;
    }
    if (cycle < 180) {
      // Rhythmic 3 Hz ictal-appearing discharges with rising amplitude.
      const ramp = Math.min(1, (cycle - 120) / 20);
      return (
        gain *
        (70 * ramp * Math.sin(2 * Math.PI * 3 * phase) +
          25 * ramp * Math.sin(2 * Math.PI * 6 * phase) +
          jitter)
      );
    }
    // Light sedation: mixed beta and theta.
    return (
      gain *
      (10 * Math.sin(2 * Math.PI * 6 * phase) +
        8 * Math.sin(2 * Math.PI * 18 * phase) +
        jitter * 1.5)
    );
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
