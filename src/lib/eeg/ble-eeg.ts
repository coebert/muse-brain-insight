/// <reference types="web-bluetooth" />
/**
 * Generic Bluetooth LE headset ingest — FocusCalm and other single/dual
 * channel consumer bands.
 *
 * The Muse client can afford to be specific: its GATT layout and packet format
 * are documented, so `muse.ts` names the service, the four electrode
 * characteristics and the 12-bit packing directly. Other consumer headsets —
 * the BrainCo FocusCalm among them — publish no public GATT map, and their
 * firmware revisions move. Hard-coding one guessed characteristic would give a
 * headband that pairs and then sits silent, which is exactly the failure this
 * module exists to remove.
 *
 * So the approach here is discovery rather than assumption:
 *
 *   1. Open the chooser wide enough that the headband appears at all (name
 *      hints for the known bands, plus an accept-all fallback), requesting a
 *      broad list of plausible services so the ones the device does expose can
 *      actually be read after pairing.
 *   2. Subscribe to *every* notifying characteristic on the device and listen
 *      for a couple of seconds.
 *   3. Score each stream against several candidate packet layouts (BrainCo's
 *      0x55 0xAA framing, plain int16/int24/float payloads) and keep the one
 *      that decodes into something with the temporal structure of EEG: heavily
 *      oversampled, so successive samples correlate strongly. A wrong byte
 *      alignment destroys that correlation, which makes it a far better
 *      discriminator than amplitude alone.
 *   4. Measure the achieved sample rate from the packets themselves and hand
 *      the stream to the shared ingest pipeline, which converts to microvolts
 *      and resamples onto the analysis rate.
 *
 * Amplitude scaling is the one thing discovery cannot settle: without the
 * vendor's ADC scale, counts cannot be turned into calibrated microvolts. The
 * source therefore auto-gains onto a plausible scalp amplitude and says so, so
 * the shape-based metrics (DSA, SEF95, entropy, seizure score) are usable while
 * anything amplitude-absolute (suppression µV threshold) is flagged as
 * uncalibrated until the clinician enters a µV-per-count factor.
 */

import { bleDiagnostics } from "@/lib/eeg/ble-diagnostics";
import {
  FOCUSCALM_PROFILE,
  profileFromChannelMap,
  type DeviceProfile,
} from "@/lib/eeg/device-profile";
import {
  decodeZenLitePacket,
  nextZenLiteMsgId,
  zenliteAfeCommand,
  ZenLiteDeframer,
  zenliteEegSamples,
  zenlitePairCommand,
  zenlitePairUuid,
  ZENLITE_AFE,
  ZENLITE_NOTIFY,
  ZENLITE_SAMPLE_RATE,
  ZENLITE_SERVICE,
  ZENLITE_WRITE,
} from "@/lib/eeg/brainco-zenlite";
import { IngestPipeline, type ChannelMap, type IngestConfig } from "@/lib/eeg/ingest";
import {
  isWebBluetoothAvailable,
  WEB_BLUETOOTH_HELP,
  type EegSource,
  type SampleHandler,
  type SourceStateHandler,
} from "@/lib/eeg/muse";

/** Advertised-name hints used only to recognise an already-authorised band. */
export const BLE_NAME_HINTS = [
  "Regul8",
  "FocusCalm",
  "Focus",
  "BrainCo",
  "Crimson",
  "Mind",
  "EEG",
  "FC-",
];

const NORDIC_UART = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";

/** Known transports used by consumer EEG headband firmware. */
const VENDOR_SERVICES: string[] = [
  ZENLITE_SERVICE, // BrainCo ZenLite (FocusCalm / Regul8 / OxyZen) data stream
  NORDIC_UART,
  "0000fe8d-0000-1000-8000-00805f9b34fb", // Muse, harmless to include
  "0000180f-0000-1000-8000-00805f9b34fb", // battery
  "0000180a-0000-1000-8000-00805f9b34fb", // device information
  "f000c0e0-0451-4000-b000-000000000000", // TI-style vendor range
  "0000ffe5-0000-1000-8000-00805f9b34fb",
];

/**
 * Bluefy proxies Web Bluetooth through iOS CoreBluetooth and becomes unreliable
 * when requestDevice receives hundreds of optional services. Keep its request
 * deliberately small; these are the plausible published/standard transports.
 */
export const IOS_BLE_CANDIDATE_SERVICES = [...VENDOR_SERVICES];

/** Services websites are forbidden from requesting by the Web Bluetooth registry. */
export const WEB_BLUETOOTH_BLOCKED_SERVICES = new Set([
  "00001812-0000-1000-8000-00805f9b34fb", // HID
  "00001530-1212-efde-1523-785feabcd123", // Nordic legacy DFU
  "f000ffc0-0451-4000-b000-000000000000", // TI OTA
  "00060000-0000-1000-8000-00805f9b34fb", // Cypress bootloader
  "0000fffd-0000-1000-8000-00805f9b34fb", // FIDO
  "0000fff9-0000-1000-8000-00805f9b34fb", // FIDO
  "0000fde2-0000-1000-8000-00805f9b34fb", // FIDO
]);

function uuid16(value: number): string {
  return `0000${value.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
}

/**
 * Services requested up front.
 *
 * Web Bluetooth only exposes services explicitly authorised in the chooser.
 * A blocklisted UUID makes Chromium reject the complete chooser request with a
 * SecurityError, so generated ranges are filtered against the official list.
 * A fully custom Regul8 UUID can still be supplied through `extraServices`.
 */
export const BLE_CANDIDATE_SERVICES: string[] = (() => {
  const list: string[] = [...VENDOR_SERVICES];
  for (let value = 0x1800; value <= 0x18ff; value++) list.push(uuid16(value));
  for (let value = 0xfc00; value <= 0xffff; value++) list.push(uuid16(value));
  return [...new Set(list)].filter((uuid) => !WEB_BLUETOOTH_BLOCKED_SERVICES.has(uuid));
})();

const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
const BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb";


/* ------------------------------------------------------------------ */
/* Packet decoding                                                     */
/* ------------------------------------------------------------------ */

export type PacketFormat =
  | "brainco-zenlite"
  | "brainco-int24be"
  | "brainco-int16le"
  | "int16le"
  | "int16be"
  | "int24be"
  | "int24le"
  | "float32le";

export const PACKET_FORMAT_LABEL: Record<PacketFormat, string> = {
  "brainco-zenlite": "BrainCo ZenLite frames, 24-bit samples",
  "brainco-int24be": "BrainCo frame, 24-bit samples",
  "brainco-int16le": "BrainCo frame, 16-bit samples",
  int16le: "Raw 16-bit little-endian",
  int16be: "Raw 16-bit big-endian",
  int24be: "Raw 24-bit big-endian",
  int24le: "Raw 24-bit little-endian",
  float32le: "Raw 32-bit float",
};

const BRAINCO_SYNC_A = 0x55;
const BRAINCO_SYNC_B = 0xaa;

/**
 * Strips BrainCo-style framing: 0x55 0xAA, one length byte, one message-type
 * byte, payload, one trailing checksum byte. Returns the concatenated payloads
 * of every complete frame found, or null when the buffer is not framed that
 * way.
 */
export function stripBrainCoFrames(bytes: Uint8Array): Uint8Array | null {
  const out: number[] = [];
  let frames = 0;
  let i = 0;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== BRAINCO_SYNC_A || bytes[i + 1] !== BRAINCO_SYNC_B) {
      i++;
      continue;
    }
    const length = bytes[i + 2] as number;
    const start = i + 4;
    const end = start + Math.max(0, length - 1);
    if (length < 2 || end > bytes.length) break;
    for (let k = start; k < end; k++) out.push(bytes[k] as number);
    frames++;
    i = end + 1;
  }
  return frames > 0 && out.length >= 6 ? Uint8Array.from(out) : null;
}

function readInt24(bytes: Uint8Array, offset: number, bigEndian: boolean): number {
  const b0 = bytes[offset] as number;
  const b1 = bytes[offset + 1] as number;
  const b2 = bytes[offset + 2] as number;
  const raw = bigEndian ? (b0 << 16) | (b1 << 8) | b2 : (b2 << 16) | (b1 << 8) | b0;
  return raw & 0x800000 ? raw - 0x1000000 : raw;
}

/** Decodes one notification payload into signed sample values. */
export function decodePacket(format: PacketFormat, bytes: Uint8Array): number[] {
  let body: Uint8Array = bytes;
  if (format === "brainco-zenlite") return decodeZenLitePacket(bytes);
  if (format.startsWith("brainco-")) {
    const stripped = stripBrainCoFrames(bytes);
    if (!stripped) return [];
    body = stripped;
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: number[] = [];
  switch (format) {
    case "brainco-int24be":
    case "int24be":
    case "int24le": {
      const big = format !== "int24le";
      for (let i = 0; i + 2 < body.length; i += 3) out.push(readInt24(body, i, big));
      break;
    }
    case "brainco-int16le":
    case "int16le": {
      for (let i = 0; i + 1 < body.length; i += 2) out.push(view.getInt16(i, true));
      break;
    }
    case "int16be": {
      for (let i = 0; i + 1 < body.length; i += 2) out.push(view.getInt16(i, false));
      break;
    }
    case "float32le": {
      for (let i = 0; i + 3 < body.length; i += 4) out.push(view.getFloat32(i, true));
      break;
    }
  }
  return out;
}

/**
 * How EEG-like a decoded series is, 0–1.
 *
 * Scalp EEG sampled at 250 Hz is heavily oversampled relative to its content,
 * so lag-1 autocorrelation is high (typically > 0.8). A mis-aligned byte
 * decode shreds that structure and lands near zero, and a stuck or constant
 * stream is rejected separately for having no variance at all.
 */
export function eegLikeness(samples: number[]): number {
  const finite = samples.filter((v) => Number.isFinite(v));
  if (finite.length < 16) return 0;
  const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
  let variance = 0;
  for (const v of finite) variance += (v - mean) ** 2;
  variance /= finite.length;
  if (!(variance > 0)) return 0;
  let cov = 0;
  for (let i = 1; i < finite.length; i++) {
    cov += ((finite[i] as number) - mean) * ((finite[i - 1] as number) - mean);
  }
  cov /= finite.length - 1;
  const r = cov / variance;
  if (!Number.isFinite(r)) return 0;
  return Math.max(0, Math.min(1, r));
}

export interface FormatDetection {
  format: PacketFormat;
  score: number;
  /** Samples recovered per notification, averaged. */
  samplesPerPacket: number;
  /** Robust amplitude of the decoded counts, used for auto-gain. */
  p95: number;
}

const FORMATS: PacketFormat[] = [
  "brainco-zenlite",
  "brainco-int24be",
  "brainco-int16le",
  "int24be",
  "int24le",
  "int16le",
  "int16be",
  "float32le",
];

function p95Abs(values: number[]): number {
  const abs = values.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  if (!abs.length) return 0;
  return abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))] as number;
}

/** Ranks candidate packet layouts against a captured burst of notifications. */
export function detectPacketFormat(packets: Uint8Array[]): FormatDetection[] {
  const results: FormatDetection[] = [];
  for (const format of FORMATS) {
    const series: number[] = [];
    let decodedPackets = 0;
    if (format === "brainco-zenlite") {
      // Vendor frames span several notifications, so they can only be scored
      // after the burst is reassembled in arrival order.
      const total = packets.reduce((n, p) => n + p.length, 0);
      const joined = new Uint8Array(total);
      let at = 0;
      for (const p of packets) {
        joined.set(p, at);
        at += p.length;
      }
      const values = decodeZenLitePacket(joined);
      if (values.length >= 32) {
        results.push({
          format,
          score: Number(eegLikeness(values).toFixed(4)),
          samplesPerPacket: Number((values.length / packets.length).toFixed(2)),
          p95: p95Abs(values),
        });
      }
      continue;
    }
    for (const p of packets) {
      const values = decodePacket(format, p);
      if (values.length) decodedPackets++;
      series.push(...values);
    }
    if (series.length < 32 || decodedPackets === 0) continue;
    results.push({
      format,
      score: Number(eegLikeness(series).toFixed(4)),
      samplesPerPacket: Number((series.length / packets.length).toFixed(2)),
      p95: p95Abs(series),
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

/** Auto-gain: µV per count that puts a robust amplitude on scalp-EEG scale. */
export function autoScaleUvPerCount(p95Counts: number, targetUv = 35): number {
  if (!(p95Counts > 0) || !Number.isFinite(p95Counts)) return 1;
  if (p95Counts >= 2 && p95Counts <= 2_000) return 1; // already plausible µV
  return Number((targetUv / p95Counts).toPrecision(4));
}

/* ------------------------------------------------------------------ */
/* Device chooser                                                      */
/* ------------------------------------------------------------------ */

/**
 * Opens the pairing chooser without a name filter. FocusCalm firmware does not
 * consistently advertise a product name (some FC-11 units advertise only a
 * serial-like name), and a name-filtered Web Bluetooth chooser hides those
 * devices completely. `optionalServices` grants access after selection; it
 * does not restrict what the clinician can see in the chooser.
 */
export async function requestBleHeadset(extraServices: string[] = []): Promise<BluetoothDevice> {
  if (!isWebBluetoothAvailable()) throw new Error(WEB_BLUETOOTH_HELP);
  const ios = isIosWebBleBrowser();
  const candidates = ios ? IOS_BLE_CANDIDATE_SERVICES : BLE_CANDIDATE_SERVICES;
  const optionalServices = [...new Set([...candidates, ...extraServices])].filter(
    (uuid) => !WEB_BLUETOOTH_BLOCKED_SERVICES.has(uuid.toLowerCase()),
  );
  // A previously approved FocusCalm can reconnect without making the clinician
  // hunt through the chooser again. Use it only when the match is unambiguous.
  const bluetooth = navigator.bluetooth as Bluetooth & {
    getDevices?: () => Promise<BluetoothDevice[]>;
  };
  // Bluefy can retain an authorised BluetoothDevice after iOS has discarded
  // the underlying CBPeripheral. Reusing that stale handle makes the picker
  // appear to work but gatt.connect() never opens. Always obtain a fresh
  // peripheral handle from Bluefy's chooser; Chromium's getDevices() remains
  // useful on platforms where the browser owns the BLE connection directly.
  if (!ios && bluetooth.getDevices) {
    const approved = await bluetooth.getDevices();
    const known = approved.filter((device) =>
      BLE_NAME_HINTS.some((hint) => device.name?.toLowerCase().startsWith(hint.toLowerCase())),
    );
    if (known.length === 1) return known[0]!;
  }
  return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
}

/** iPadOS can identify as macOS, so touch capability is part of detection. */
export function isIosWebBleBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/* ------------------------------------------------------------------ */
/* Source                                                              */
/* ------------------------------------------------------------------ */

/** What discovery found, shown to the clinician before the case starts. */
export interface BleDiscovery {
  deviceName: string;
  serviceUuid: string;
  characteristicUuid: string;
  format: PacketFormat;
  score: number;
  packetsPerSecond: number;
  sampleRate: number;
  uvPerCount: number;
  autoScaled: boolean;
  notes: string[];
  /** Every notifying characteristic seen, for troubleshooting. */
  candidates: { characteristicUuid: string; format: PacketFormat | null; score: number }[];
}

interface BleStreamCandidate {
  service: BluetoothRemoteGATTService;
  characteristic: BluetoothRemoteGATTCharacteristic;
}

interface BleCapturedCandidate extends BleStreamCandidate {
  packets: Uint8Array[];
  notificationStarted: boolean;
  subscriptionError: string | null;
  captureMode: "notification" | "read";
}

export interface BleHeadsetOptions {
  device?: BluetoothDevice;
  /** Analysis electrodes the single stream should feed. */
  channelMap?: ChannelMap;
  /** Clinician-supplied ADC scale; skips auto-gain when provided. */
  uvPerCount?: number;
  /** Overrides the measured rate when the clinician knows the device rate. */
  sampleRate?: number;
  /** Seconds of listening used to pick the stream. Kept short at the bedside. */
  listenSeconds?: number;
  extraServices?: string[];
  label?: string;
  /** Bedside-friendly progress updates while the device is being prepared. */
  onProgress?: (progress: BleConnectionProgress) => void;
}

export type BleConnectionStage = "choosing" | "connecting" | "discovering" | "checking" | "ready";

export interface BleConnectionProgress {
  stage: BleConnectionStage;
  message: string;
}

/** Converts low-level Web Bluetooth failures into a short recovery action. */
export function friendlyBleError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (name === "NotFoundError" || /cancel|no device selected/i.test(message)) {
    return "No headband was selected. Hold its power button until the light blinks blue, then retry and choose it from the list (Regul8, FocusCalm, FC-11, or a serial number).";
  }
  if (name === "SecurityError" && /blocklist|blocked service|invalid service/i.test(message)) {
    return "The browser rejected a requested Bluetooth service. Reload MindGuard to use the corrected service list, then retry.";
  }
  if (name === "SecurityError" || /permission|not allowed/i.test(message)) {
    return "Bluetooth permission was blocked. Allow Bluetooth for this site in the browser settings, then retry.";
  }
  if (/not supported|not implemented|ns(error|internal)|operation.*progress/i.test(message)) {
    return "Bluefy could not complete this Bluetooth operation. Update Bluefy and retry once; if it fails at the same stage, use Chrome on Android or desktop because this headband’s notification stream is not compatible with the current iOS Bluetooth bridge.";
  }
  if (/gatt|network|disconnected|connection/i.test(message)) {
    return "The headband was found but would not connect. Unplug its charging cable, close the headband’s own phone app on any nearby device, then switch the band off and on and retry.";
  }
  if (/no readable services|no streaming characteristic/i.test(message)) {
    return "The headband connected but did not expose its EEG stream. Close the headband’s own phone app, unplug the charging cable, restart the band, and retry.";
  }
  if (/no stream decoded as eeg/i.test(message)) {
    return "Connected, but no usable EEG signal arrived. Wear the band snugly across a clean forehead, keep still for a few seconds, and retry.";
  }
  return message || "The headband could not be connected. Restart it and try again.";
}


/**
 * A discovered BLE EEG stream presented as an ordinary `EegSource`, so the
 * monitor, lineage gating and every downstream metric treat it exactly like
 * any other non-Muse amplifier.
 */
/* ------------------------------------------------------------------ */
/* Live connection health                                              */
/* ------------------------------------------------------------------ */

/**
 * What the bedside needs to know before a case starts, and while it runs:
 * is the link up, are packets decoding, is the stream at the rate discovery
 * measured, and does the signal look like scalp EEG rather than a flat or
 * railed electrode.
 */
export interface BleStreamHealth {
  /** GATT link state. */
  connected: boolean;
  /** Auto-reconnect currently retrying. */
  reconnecting: boolean;
  /** Which automatic attempt is in flight (0 when the link is healthy). */
  reconnectAttempt: number;
  /** Milliseconds until the next automatic attempt, 0 when none is scheduled. */
  nextRetryInMs: number;
  /** Notifications arriving in the last few seconds. */
  packetsPerSecond: number;
  /** Notifications that decoded into samples (a decode failure shows as 0). */
  decodedPacketsPerSecond: number;
  samplesPerSecond: number;
  /** Rate discovery settled on, for comparison. */
  expectedSampleRate: number;
  /** Delivered rate as a fraction of the expected rate. */
  rateRatio: number;
  /** Robust amplitude of the delivered signal, microvolts. */
  amplitudeUv: number;
  quality: "none" | "poor" | "fair" | "good";
  qualityReason: string;
  msSinceLastPacket: number;
  totalPackets: number;
  totalSamples: number;
  /** True when every check passes and a case can safely begin. */
  ready: boolean;
}

const COLUMN = "ble";
const HEALTH_WINDOW_MS = 4_000;
/** First automatic re-pairing delay, milliseconds. */
export const BLE_RETRY_BASE_MS = 1_000;
/** Longest gap between automatic attempts, milliseconds. */
export const BLE_RETRY_MAX_MS = 60_000;
/** Attempts made quietly before the bedside is told the link is lost. */
export const BLE_RETRY_QUIET_ATTEMPTS = 5;

/**
 * Exponential backoff for automatic resume: 1s, 2s, 4s … capped at a minute,
 * with ±20% jitter so a theatre full of bands does not retry in lockstep.
 * Retrying never stops — a band that comes back an hour later rejoins the
 * running case rather than requiring a new one.
 */
export function bleRetryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(BLE_RETRY_MAX_MS, BLE_RETRY_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random()));
}
/** No packets for this long with the link nominally up: treat it as dropped. */
const BLE_STALL_MS = 6_000;

/**
 * A discovered BLE EEG stream presented as an ordinary `EegSource`, so the
 * monitor, lineage gating and every downstream metric treat it exactly like
 * any other non-Muse amplifier.
 *
 * Two behaviours beyond plain discovery matter at the bedside:
 *
 *   * **One-tap resume.** A band that slips, browns out or wanders out of
 *     range is re-opened automatically with backoff, reusing the authorised
 *     device handle and the characteristic discovery already settled on — no
 *     chooser, no new case, no lost timeline. `reconnect()` short-cuts the
 *     backoff when the clinician taps the button.
 *   * **Live health.** Packets, decoded packets, delivered sample rate and a
 *     robust amplitude are tracked continuously, so the panel can prove the
 *     stream is real before the case starts and keep proving it afterwards.
 */
export class BleHeadsetSource implements EegSource {
  name = "BLE headset";
  profile: DeviceProfile = FOCUSCALM_PROFILE;
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private readPollTimer: ReturnType<typeof setTimeout> | null = null;
  private zenlite = new ZenLiteDeframer();
  private batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  private pipeline: IngestPipeline | null = null;
  private format: PacketFormat = "int16le";
  private scale = 1;
  private stopping = false;
  private started = false;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private nextRetryAt = 0;
  private retryWake: (() => void) | null = null;
  private linkWaiters: ((ok: boolean) => void)[] = [];
  private listener: ((event: Event) => void) | null = null;
  private batteryListener: ((event: Event) => void) | null = null;
  private disconnectListener: (() => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private stateCb: SourceStateHandler | null = null;
  private batteryCb: ((percent: number) => void) | null = null;
  private discoveryCb: ((d: BleDiscovery) => void) | null = null;
  private healthCb: ((h: BleStreamHealth) => void) | null = null;
  private samplesCb: SampleHandler | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** Rolling packet log: [arrivedAt, decodedSamples, robust amplitude µV]. */
  private packetLog: [number, number, number][] = [];
  private totalPackets = 0;
  private totalSamples = 0;
  private lastPacketAt = 0;
  discovery: BleDiscovery | null = null;

  constructor(private readonly options: BleHeadsetOptions = {}) {
    if (options.label) this.name = options.label;
  }

  onDisconnect(cb: () => void) {
    this.disconnectCb = cb;
  }

  onState(cb: SourceStateHandler) {
    this.stateCb = cb;
  }

  onBattery(cb: (percent: number) => void) {
    this.batteryCb = cb;
  }

  /** Reports what discovery settled on, once the stream has been identified. */
  onDiscovery(cb: (d: BleDiscovery) => void) {
    this.discoveryCb = cb;
  }

  /** Live stream health, refreshed twice a second while the source is open. */
  onHealth(cb: (h: BleStreamHealth) => void) {
    this.healthCb = cb;
    if (this.started) cb(this.health());
  }

  /**
   * Opens the headset and begins delivering samples. Calling it again on an
   * already-open source only re-points the sample sink — the pairing panel
   * verifies health first, then the case adopts the same live stream without
   * a second pairing round-trip.
   */
  async start(onSamples: SampleHandler) {
    this.samplesCb = onSamples;
    if (this.started) {
      this.stateCb?.({ kind: "connected" });
      return;
    }
    if (!isWebBluetoothAvailable()) throw new Error(WEB_BLUETOOTH_HELP);
    this.stopping = false;
    bleDiagnostics.beginSession(this.options.label ?? this.name);
    this.progress("choosing", "Choose the headband from the Bluetooth list");
    const device = this.options.device ?? (await requestBleHeadset(this.options.extraServices));
    this.device = device;
    this.name = this.options.label ?? device.name ?? "BLE headset";
    bleDiagnostics.add("session", "Device selected", {
      name: device.name ?? null,
      id: device.id ? `${String(device.id).slice(0, 6)}…` : null,
      ios: isIosWebBleBrowser(),
    });
    this.disconnectListener = () => {
      if (this.stopping) return;
      this.characteristic = null;
      this.stateCb?.({ kind: "reconnecting", attempt: 1, attempts: BLE_RETRY_QUIET_ATTEMPTS });
      void this.attemptReconnect();
    };
    device.addEventListener("gattserverdisconnected", this.disconnectListener);

    try {
      await this.attach();
      this.started = true;
      this.startHealthLoop();
    } catch (error) {
      // A failed discovery still leaves Chrome's GATT link open. Without a
      // full cleanup, the next click creates another source while this one
      // continues to hold the Regul8 session, making every retry fail even
      // after the original radio problem has cleared.
      await this.releaseFailedStart();
      throw error;
    }
  }

  /** Releases every resource acquired before start() completed successfully. */
  private async releaseFailedStart() {
    this.stopping = true;
    this.detachStream();
    this.detachBattery();
    if (this.device && this.disconnectListener) {
      this.device.removeEventListener("gattserverdisconnected", this.disconnectListener);
    }
    this.disconnectListener = null;
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* the browser may already have closed the failed link */
    }
    this.device = null;
    this.samplesCb = null;
  }

  /**
   * Opens GATT with retries. Chrome routinely fails the very first connect to
   * a freshly advertised band with a bare "GATT operation failed" or
   * "connection attempt failed" — the radio is still finishing the pairing
   * handshake. One attempt therefore looks like "the app can see it but can
   * never connect"; three spaced attempts succeed.
   */
  private async connectGatt(device: BluetoothDevice): Promise<BluetoothRemoteGATTServer> {
    const gatt = device.gatt;
    if (!gatt) throw new Error("The selected device does not expose a Bluetooth GATT connection.");
    const ios = isIosWebBleBrowser();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.stopping) break;
      try {
        if (attempt > 0) {
          this.progress("connecting", `Retrying the link to ${this.name} (${attempt + 1} of 3)`);
          // Do not disconnect a link which Bluefy/CoreBluetooth is still
          // finishing asynchronously. That turns a recoverable delayed
          // connection into a permanent "could not open GATT" loop.
          if (gatt.connected) {
            try {
              gatt.disconnect();
            } catch {
              /* already closed */
            }
          }
          await new Promise((r) => setTimeout(r, (ios ? 1_500 : 700) * attempt));
        }
        bleDiagnostics.add("gatt", `GATT connect attempt ${attempt + 1}`, { ios });
        const server = await gatt.connect();
        // Bluefy may resolve connect() while its CoreBluetooth delegate is
        // still promoting the peripheral to connected. Chromium normally has
        // connected=true immediately, so this wait is effectively free there.
        const settleUntil = Date.now() + (ios ? 4_000 : 500);
        while (!server.connected && Date.now() < settleUntil && !this.stopping) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (server.connected) {
          bleDiagnostics.add("gatt", "GATT connected", { attempt: attempt + 1 });
          return server;
        }
        bleDiagnostics.add("error", "GATT connect resolved but link never became connected", {
          attempt: attempt + 1,
        });
        lastError = new Error("Could not open a GATT connection to the headset.");
      } catch (e) {
        bleDiagnostics.add("error", "GATT connect threw", {
          attempt: attempt + 1,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        });
        lastError = e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Could not open a GATT connection to the headset.");
  }

  /** Opens GATT, discovers the stream and subscribes. Used by start and retry. */
  private async attach() {
    const device = this.device;
    if (!device) throw new Error("No headset has been paired yet.");
    this.progress("connecting", `Connecting to ${this.name}`);
    const server = await this.connectGatt(device);

    this.progress("discovering", "Finding the EEG stream");
    // Some firmware answers service discovery only a moment after the link is
    // up; a single empty result is not proof the band has nothing to offer.
    let services: BluetoothRemoteGATTService[] = [];
    for (let attempt = 0; attempt < 3 && !services.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
      try {
        services = await server.getPrimaryServices();
      } catch (error) {
        bleDiagnostics.add("error", "Service discovery failed", {
          attempt: attempt + 1,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        services = [];
      }
    }
    bleDiagnostics.add("service", `Discovered ${services.length} primary service(s)`, {
      services: services.map((s) => s.uuid),
    });
    if (!services.length)
      throw new Error(
        "The headset connected but exposed no readable services. Close any phone app holding the band, unplug the charging cable, then switch it off and on and retry.",
      );

    await this.attachBattery(server);
    this.zenlite.reset();

    // Fast path on a resume: the characteristic and packet layout are already
    // known, so re-subscribe directly instead of re-running the listen-and-
    // score sweep the clinician already waited through once.
    if (this.discovery) {
      const known = await this.findKnownCharacteristic(services);
      if (known) {
        await this.bindStream(known);
        await this.zenliteHandshake(services);
        this.progress("ready", "EEG stream resumed");
        this.stateCb?.({ kind: "connected" });
        return;
      }
    }

    const notifying: BleStreamCandidate[] = [];
    const readable: BleStreamCandidate[] = [];
    for (const service of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await service.getCharacteristics();
      } catch (error) {
        bleDiagnostics.add("error", `Characteristic discovery failed on ${service.uuid}`, {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        continue;
      }
      bleDiagnostics.add("characteristic", `${service.uuid}: ${chars.length} characteristic(s)`, {
        characteristics: chars.map((c) => ({
          uuid: c.uuid,
          properties: Object.entries({
            read: c.properties.read,
            write: c.properties.write,
            writeWithoutResponse: c.properties.writeWithoutResponse,
            notify: c.properties.notify,
            indicate: c.properties.indicate,
          })
            .filter(([, on]) => on)
            .map(([name]) => name),
        })),
      });
      for (const characteristic of chars) {
        if (characteristic.properties.notify || characteristic.properties.indicate) {
          notifying.push({ service, characteristic });
        }
        if (characteristic.properties.read) readable.push({ service, characteristic });
      }
    }
    if (!notifying.length)
      throw new Error(
        `No streaming characteristic was found on this headset (${services.length} authorised services readable). If this is a BrainCo band (Regul8/FocusCalm), put it into pairing mode (blue flashing LED) and retry, since the EEG service is only exposed once pairing succeeds.`,
      );

    this.progress("checking", "Checking the EEG signal — keep still");
    const listenMs = Math.max(1_000, (this.options.listenSeconds ?? 3) * 1000);
    // ZenLite pairing responses and stream acknowledgements arrive on the
    // notification characteristic. Subscribe first, then send the activation
    // sequence; doing this in the opposite order can leave Bluefy with a live
    // GATT link but a permanently silent EEG stream.
    let captured = await this.listen(notifying, listenMs, () => this.zenliteHandshake(services));
    let chosen = this.choose(captured, listenMs / 1000);
    // Some iOS Web Bluetooth bridges acknowledge notification setup but never
    // forward characteristicvaluechanged events. A short, conservative read
    // fallback recovers firmware that exposes its current stream buffer through
    // a readable characteristic, without writing undocumented start commands.
    if (!chosen && captured.every((candidate) => !candidate.packets.length) && readable.length) {
      const readCaptured = await this.pollReadable(readable, Math.min(listenMs, 3_000));
      captured = [...captured, ...readCaptured];
      chosen = this.choose(captured, listenMs / 1000);
    }
    // Do not write guessed start commands to an undocumented medical-adjacent
    // device. A verified command can be added when the vendor protocol is known.
    if (!chosen) {
      const silent = captured.every((c) => !c.packets.length);
      const subscriptions = captured.filter((candidate) => candidate.notificationStarted).length;
      const subscriptionErrors = captured
        .map((candidate) => candidate.subscriptionError)
        .filter((message): message is string => Boolean(message));
      const characteristicSummary = captured
        .map(
          (candidate) =>
            `${candidate.service.uuid}/${candidate.characteristic.uuid}: ${candidate.packets.length} packets`,
        )
        .join(", ");
      bleDiagnostics.add("error", "No characteristic decoded as EEG", {
        subscriptions,
        subscriptionErrors,
        perCharacteristic: characteristicSummary || "none",
        packetTotals: bleDiagnostics.packetTotals(),
      });
      throw new Error(
        subscriptions === 0 && subscriptionErrors.length
          ? `The headband connected, but notification subscription failed (${subscriptionErrors.join("; ")}).`
          : silent
          ? `The headband connected and ${subscriptions} notification stream${subscriptions === 1 ? " was" : "s were"} opened, but none sent data. Characteristics checked: ${characteristicSummary || "none"}. This firmware may require the vendor's private stream-start protocol.`
          : "The headset connected but no stream decoded as EEG. Check the band is worn and powered, and that no other app holds the connection.",
      );
    }


    bleDiagnostics.add("info", "EEG stream selected", {
      service: chosen.discovery.serviceUuid,
      characteristic: chosen.discovery.characteristicUuid,
      format: chosen.discovery.format,
      score: chosen.discovery.score,
      captureMode: chosen.captureMode,
      candidates: chosen.discovery.candidates,
    });
    this.format = chosen.discovery.format;
    // The vendor protocol publishes its own rate, which is more trustworthy
    // than one measured over a couple of seconds of BLE-jittered packets.
    const protocolRate =
      chosen.discovery.format === "brainco-zenlite" ? ZENLITE_SAMPLE_RATE : undefined;
    const measuredRate = this.options.sampleRate ?? protocolRate ?? chosen.discovery.sampleRate;
    const uvPerCount = this.options.uvPerCount ?? chosen.discovery.uvPerCount;
    this.scale = uvPerCount;
    const channelMap: ChannelMap =
      this.options.channelMap ?? { TP9: null, AF7: COLUMN, AF8: null, TP10: null };
    const config: IngestConfig = {
      sampleRate: measuredRate,
      unit: "counts",
      uvPerCount,
      channelMap,
      label: this.name,
    };
    this.profile = this.buildProfile(channelMap, measuredRate);
    this.pipeline = new IngestPipeline(config, (ch, samples) => this.samplesCb?.(ch, samples));
    if (this.pipeline.mappedCount === 0)
      throw new Error("Map the headset stream onto at least one analysis electrode.");

    // Re-subscribe to the winning characteristic only.
    await this.detachAll(notifying, chosen.characteristic);
    this.discovery = { ...chosen.discovery, uvPerCount, sampleRate: measuredRate };
    if (chosen.captureMode === "read") {
      await this.bindReadableStream(chosen.characteristic);
    } else {
      await this.bindStream(chosen.characteristic);
    }
    this.discoveryCb?.(this.discovery);
    this.progress("ready", "EEG signal confirmed");
    this.stateCb?.({ kind: "connected" });
  }

  /**
   * Runs the BrainCo ZenLite pairing and start-stream handshake.
   *
   * Headbands in this family (FocusCalm, Regul8, OxyZen) open GATT and then
   * stay silent until the host pairs and switches the EEG front end on. The
   * commands are only ever sent to a band that actually exposes the vendor
   * service, so no other device receives an unrecognised write.
   */
  private async zenliteHandshake(services: BluetoothRemoteGATTService[]) {
    const service = services.find((s) => s.uuid.toLowerCase() === ZENLITE_SERVICE);
    if (!service) {
      bleDiagnostics.add("info", "BrainCo vendor service absent — no activation sent", {
        expected: ZENLITE_SERVICE,
      });
      return;
    }
    let write: BluetoothRemoteGATTCharacteristic | null = null;
    try {
      write = await service.getCharacteristic(ZENLITE_WRITE);
    } catch (error) {
      bleDiagnostics.add("error", "BrainCo command characteristic not available", {
        expected: ZENLITE_WRITE,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      return;
    }
    if (!write) return;
    const send = async (frame: Uint8Array, label: string) => {
      // Prefer acknowledged writes. Some iOS Web Bluetooth bridges advertise
      // write-without-response but silently drop it; the ZenLite command
      // characteristic also supports ordinary writes on known firmware.
      const mode = write?.properties.write
        ? "write"
        : write?.properties.writeWithoutResponse
        ? "writeWithoutResponse"
        : "none";
      bleDiagnostics.add("command", label, { characteristic: write?.uuid, mode }, frame);
      if (write?.properties.write) {
        await write.writeValue(frame as BufferSource);
      } else if (write?.properties.writeWithoutResponse) {
        await write.writeValueWithoutResponse(frame as BufferSource);
      } else {
        throw new Error("The BrainCo command characteristic is not writable.");
      }
    };
    this.progress("discovering", "Pairing with the headband");
    try {
      // Pair first (band in pairing mode); if it is already paired the same
      // identity re-validates instead, which the firmware accepts silently.
      await send(zenlitePairCommand(nextZenLiteMsgId(), true, zenlitePairUuid()), "ZenLite pair");
      await new Promise((r) => setTimeout(r, 300));
      await send(
        zenlitePairCommand(nextZenLiteMsgId(), false, zenlitePairUuid()),
        "ZenLite re-validate",
      );
      await new Promise((r) => setTimeout(r, 300));
      this.progress("discovering", "Starting the EEG stream");
      await send(zenliteAfeCommand(nextZenLiteMsgId(), ZENLITE_AFE.sr256), "ZenLite AFE start 256 Hz");
      await new Promise((r) => setTimeout(r, 200));
      bleDiagnostics.add("info", "ZenLite activation sequence sent");
    } catch (error) {
      bleDiagnostics.add("error", "ZenLite activation failed", {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      throw new Error(
        `The BrainCo EEG start command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Re-locates the characteristic discovery already chose, after a resume. */
  private async findKnownCharacteristic(services: BluetoothRemoteGATTService[]) {
    const target = this.discovery;
    if (!target) return null;
    for (const service of services) {
      if (service.uuid.toLowerCase() !== target.serviceUuid.toLowerCase()) continue;
      try {
        const chars = await service.getCharacteristics();
        return (
          chars.find(
            (c) => c.uuid.toLowerCase() === target.characteristicUuid.toLowerCase(),
          ) ?? null
        );
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Subscribes to the chosen characteristic and starts counting health. */
  private async bindStream(characteristic: BluetoothRemoteGATTCharacteristic) {
    this.characteristic = characteristic;
    this.listener = (event: Event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (!value) return;
      this.processPacket(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    };
    characteristic.addEventListener("characteristicvaluechanged", this.listener);
    try {
      await characteristic.startNotifications();
    } catch (error) {
      characteristic.removeEventListener("characteristicvaluechanged", this.listener);
      this.listener = null;
      this.characteristic = null;
      throw new Error(
        `EEG notification subscription failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Keeps polling firmware whose live buffer is readable but does not notify. */
  private async bindReadableStream(characteristic: BluetoothRemoteGATTCharacteristic) {
    this.characteristic = characteristic;
    try {
      await characteristic.stopNotifications();
    } catch {
      /* It may never have accepted notification setup. */
    }
    const poll = async () => {
      if (this.stopping || this.characteristic !== characteristic) return;
      try {
        const value = await characteristic.readValue();
        if (value.byteLength > 0) {
          this.processPacket(
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          );
        }
      } catch {
        // The normal stall watchdog will rebuild the link if reads stay silent.
      }
      if (!this.stopping && this.characteristic === characteristic) {
        this.readPollTimer = setTimeout(() => void poll(), 40);
      }
    };
    await poll();
  }

  private processPacket(bytes: Uint8Array) {
    // ZenLite frames are MTU-fragmented, so they are reassembled statefully
    // rather than decoded notification by notification.
    const decoded =
      this.format === "brainco-zenlite"
        ? this.zenlite.push(bytes).flatMap((payload) => zenliteEegSamples(payload))
        : decodePacket(this.format, bytes);
    const now = Date.now();
    this.lastPacketAt = now;
    this.totalPackets++;
    this.totalSamples += decoded.length;
    this.packetLog.push([now, decoded.length, p95Abs(decoded) * this.scale]);
    if (this.packetLog.length > 2_000) this.packetLog.splice(0, this.packetLog.length - 2_000);
    if (!decoded.length) return;
    this.pipeline?.push({ [COLUMN]: Float64Array.from(decoded) });
  }


  private progress(stage: BleConnectionStage, message: string) {
    this.options.onProgress?.({ stage, message });
  }

  /* ---------------------------------------------------------------- */
  /* Health                                                            */
  /* ---------------------------------------------------------------- */

  private startHealthLoop() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      if (this.stopping) return;
      const health = this.health();
      this.healthCb?.(health);
      // Link nominally up but silent: the band has stopped streaming, which
      // GATT does not always report. Rebuild it rather than sit on dead air.
      if (
        this.started &&
        !this.reconnecting &&
        this.lastPacketAt &&
        Date.now() - this.lastPacketAt > BLE_STALL_MS
      ) {
        void this.attemptReconnect();
      }
    }, 500);
  }

  /** Current stream health, computed over the last few seconds of packets. */
  health(): BleStreamHealth {
    const now = Date.now();
    const cutoff = now - HEALTH_WINDOW_MS;
    const recent = this.packetLog.filter(([t]) => t >= cutoff);
    const seconds = HEALTH_WINDOW_MS / 1000;
    const packetsPerSecond = Number((recent.length / seconds).toFixed(1));
    const decoded = recent.filter(([, n]) => n > 0);
    const decodedPerSecond = Number((decoded.length / seconds).toFixed(1));
    const samplesPerSecond = Number(
      (recent.reduce((sum, [, n]) => sum + n, 0) / seconds).toFixed(1),
    );
    const amplitudes = decoded.map(([, , uv]) => uv).sort((a, b) => a - b);
    const amplitudeUv = amplitudes.length
      ? Number((amplitudes[Math.floor(amplitudes.length / 2)] as number).toFixed(1))
      : 0;
    const expectedSampleRate = this.discovery?.sampleRate ?? this.profile.sampleRate;
    const rateRatio = expectedSampleRate ? samplesPerSecond / expectedSampleRate : 0;
    const connected = Boolean(this.device?.gatt?.connected) && Boolean(this.characteristic);
    const msSinceLastPacket = this.lastPacketAt ? now - this.lastPacketAt : Number.POSITIVE_INFINITY;

    let quality: BleStreamHealth["quality"] = "good";
    let qualityReason = "Amplitude and rate consistent with scalp EEG.";
    if (!connected || !recent.length) {
      quality = "none";
      qualityReason = connected ? "No packets are arriving from the headset." : "The link is down.";
    } else if (decodedPerSecond === 0) {
      quality = "none";
      qualityReason = "Packets arrive but none decode — the packet layout no longer matches.";
    } else if (amplitudeUv < 1.5) {
      quality = "poor";
      qualityReason = "Signal is nearly flat — the electrodes are probably not touching skin.";
    } else if (amplitudeUv > 250) {
      quality = "poor";
      qualityReason = "Very large excursions — movement, muscle or a loose electrode.";
    } else if (rateRatio < 0.7 || rateRatio > 1.4) {
      quality = "fair";
      qualityReason = "Delivered sample rate is drifting from the rate discovery measured.";
    } else if (amplitudeUv > 120) {
      quality = "fair";
      qualityReason = "Amplitude is high — settle the patient and reseat the band.";
    }

    return {
      connected,
      reconnecting: this.reconnecting,
      reconnectAttempt: this.reconnectAttempt,
      nextRetryInMs: this.nextRetryAt ? Math.max(0, this.nextRetryAt - Date.now()) : 0,
      packetsPerSecond,
      decodedPacketsPerSecond: decodedPerSecond,
      samplesPerSecond,
      expectedSampleRate,
      rateRatio: Number(rateRatio.toFixed(2)),
      amplitudeUv,
      quality,
      qualityReason,
      msSinceLastPacket,
      totalPackets: this.totalPackets,
      totalSamples: this.totalSamples,
      ready:
        connected &&
        decodedPerSecond > 0 &&
        samplesPerSecond > 0 &&
        rateRatio >= 0.7 &&
        rateRatio <= 1.4 &&
        (quality === "good" || quality === "fair"),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Reconnection                                                      */
  /* ---------------------------------------------------------------- */

  private detachStream() {
    if (this.readPollTimer) clearTimeout(this.readPollTimer);
    this.readPollTimer = null;
    if (this.characteristic && this.listener) {
      this.characteristic.removeEventListener("characteristicvaluechanged", this.listener);
      try {
        void this.characteristic.stopNotifications().catch(() => {});
      } catch {
        /* the link is already gone */
      }
    }
    this.listener = null;
    this.characteristic = null;
  }

  private settleWaiters(ok: boolean) {
    const waiters = this.linkWaiters;
    this.linkWaiters = [];
    for (const resolve of waiters) resolve(ok);
  }

  private waitForRetry(ms: number) {
    this.nextRetryAt = Date.now() + ms;
    return new Promise<void>((resolve) => {
      const id = setTimeout(() => {
        this.retryWake = null;
        this.nextRetryAt = 0;
        resolve();
      }, ms);
      this.retryWake = () => {
        clearTimeout(id);
        this.retryWake = null;
        this.nextRetryAt = 0;
        resolve();
      };
    });
  }

  /**
   * Automatic resume with backoff. The case keeps running throughout: the gap
   * is recorded, the timeline is untouched, and the stream picks up where it
   * left off as soon as the band answers.
   */
  private async attemptReconnect() {
    if (this.reconnecting || this.stopping || !this.started) return;
    this.reconnecting = true;
    const attempts = BLE_RETRY_QUIET_ATTEMPTS;
    let told = false;
    for (let i = 0; !this.stopping; i++) {
      this.reconnectAttempt = i + 1;
      this.stateCb?.({ kind: "reconnecting", attempt: Math.min(i + 1, attempts), attempts });
      await this.waitForRetry(bleRetryDelayMs(i));
      if (this.stopping) break;
      try {
        this.detachStream();
        try {
          this.device?.gatt?.disconnect();
        } catch {
          /* already closed */
        }
        await this.attach();
        this.lastPacketAt = Date.now();
        this.reconnecting = false;
        this.reconnectAttempt = 0;
        this.nextRetryAt = 0;
        this.settleWaiters(true);
        this.stateCb?.({ kind: "connected" });
        return;
      } catch {
        this.settleWaiters(false);
        if (i + 1 >= attempts && !told) {
          told = true;
          this.stateCb?.({
            kind: "lost",
            reason:
              "The headband has not come back yet — the case and its data are kept and reconnection keeps retrying. Check the band is on, charged and not held by the phone app.",
          });
          this.disconnectCb?.();
        }
      }
    }
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.nextRetryAt = 0;
    this.settleWaiters(false);
  }

  /** One-tap manual resume: short-cuts the backoff and reports the outcome. */
  async reconnect(): Promise<boolean> {
    if (!this.device || !this.started) return false;
    this.stopping = false;
    if (this.reconnecting) {
      const outcome = new Promise<boolean>((resolve) => this.linkWaiters.push(resolve));
      this.retryWake?.();
      return outcome;
    }
    this.reconnecting = true;
    this.stateCb?.({ kind: "reconnecting", attempt: 1, attempts: 1 });
    try {
      this.detachStream();
      try {
        this.device.gatt?.disconnect();
      } catch {
        /* already closed */
      }
      await this.attach();
      this.lastPacketAt = Date.now();
      this.reconnecting = false;
      this.stateCb?.({ kind: "connected" });
      return true;
    } catch (e) {
      this.reconnecting = false;
      this.stateCb?.({ kind: "lost", reason: friendlyBleError(e) });
      // Keep trying quietly rather than leaving the case with no link.
      void this.attemptReconnect();
      return false;
    }
  }

  /** Subscribes to everything that notifies and collects a burst of packets. */
  private async listen(
    notifying: BleStreamCandidate[],
    listenMs: number,
    afterSubscriptions?: () => Promise<void>,
  ) {
    const captured = new Map<
      string,
      BleCapturedCandidate
    >();
    const handlers: [BluetoothRemoteGATTCharacteristic, (e: Event) => void][] = [];
    const priority = (entry: BleStreamCandidate) => {
      if (entry.characteristic.uuid.toLowerCase() === ZENLITE_NOTIFY) return 2;
      if (entry.service.uuid.toLowerCase() === NORDIC_UART) return 1;
      return 0;
    };
    const ordered = [...notifying].sort((a, b) => priority(b) - priority(a));

    for (let index = 0; index < ordered.length; index++) {
      const entry = ordered[index]!;
      const key = `${entry.service.uuid}/${entry.characteristic.uuid}`;
      captured.set(key, {
        ...entry,
        packets: [],
        notificationStarted: false,
        subscriptionError: null,
        captureMode: "notification",
      });
      const handler = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const bucket = captured.get(key);
        if (!bucket || bucket.packets.length > 600) return;
        bucket.packets.push(new Uint8Array(value.buffer.slice(0) as ArrayBuffer));
      };
      entry.characteristic.addEventListener("characteristicvaluechanged", handler);
      handlers.push([entry.characteristic, handler]);
      try {
        await entry.characteristic.startNotifications();
        const bucket = captured.get(key);
        if (bucket) bucket.notificationStarted = true;
      } catch (error) {
        const bucket = captured.get(key);
        if (bucket) {
          bucket.subscriptionError = error instanceof Error ? error.message : String(error);
        }
      }
      // Avoid overwhelming compact headset firmware with back-to-back GATT
      // operations when several characteristics advertise notifications.
      if (index < ordered.length - 1) await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await afterSubscriptions?.();
    await new Promise((r) => setTimeout(r, listenMs));
    for (const [characteristic, handler] of handlers) {
      characteristic.removeEventListener("characteristicvaluechanged", handler);
    }
    return [...captured.values()];
  }

  /** Samples readable stream buffers when notification delivery is silent. */
  private async pollReadable(readable: BleStreamCandidate[], listenMs: number) {
    const captured: BleCapturedCandidate[] = readable.map((entry) => ({
      ...entry,
      packets: [],
      notificationStarted: false,
      subscriptionError: null,
      captureMode: "read",
    }));
    const deadline = Date.now() + listenMs;
    while (Date.now() < deadline) {
      for (const entry of captured) {
        try {
          const value = await entry.characteristic.readValue();
          if (value.byteLength > 0 && entry.packets.length <= 600) {
            entry.packets.push(
              new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)),
            );
          }
        } catch {
          /* Another readable characteristic may still expose the stream. */
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
    return captured;
  }

  /** Picks the most EEG-like stream from the captured burst. */
  private choose(
    captured: BleCapturedCandidate[],
    seconds: number,
  ) {
    const candidates: BleDiscovery["candidates"] = [];
    let best: {
      characteristic: BluetoothRemoteGATTCharacteristic;
      discovery: BleDiscovery;
      captureMode: BleCapturedCandidate["captureMode"];
    } | null = null;
    for (const entry of captured) {
      const ranked = detectPacketFormat(entry.packets);
      const top = ranked[0] ?? null;
      candidates.push({
        characteristicUuid: entry.characteristic.uuid,
        format: top?.format ?? null,
        score: top?.score ?? 0,
      });
      if (!top || top.score < 0.6) continue;
      const packetsPerSecond = entry.packets.length / seconds;
      const rate = Math.max(32, Math.round(packetsPerSecond * top.samplesPerPacket));
      const uvPerCount = autoScaleUvPerCount(top.p95);
      const notes: string[] = [];
      if (uvPerCount !== 1)
        notes.push(
          `Amplitude auto-scaled (${uvPerCount} µV per count) — relative shape metrics are valid, but absolute microvolt thresholds such as the suppression cut-off are uncalibrated until you enter the device's ADC scale.`,
        );
      notes.push(`Sample rate measured from the link: ${rate} Hz, resampled to the analysis rate.`);
      const discovery: BleDiscovery = {
        deviceName: this.name,
        serviceUuid: entry.service.uuid.toLowerCase(),
        characteristicUuid: entry.characteristic.uuid.toLowerCase(),
        format: top.format,
        score: top.score,
        packetsPerSecond: Number(packetsPerSecond.toFixed(1)),
        sampleRate: rate,
        uvPerCount,
        autoScaled: uvPerCount !== 1,
        notes,
        candidates,
      };
      if (!best || top.score > best.discovery.score) {
        best = { characteristic: entry.characteristic, discovery, captureMode: entry.captureMode };
      }
    }
    if (best) best.discovery.candidates = candidates;
    return best;
  }

  private async detachAll(
    notifying: {
      service: BluetoothRemoteGATTService;
      characteristic: BluetoothRemoteGATTCharacteristic;
    }[],
    keep: BluetoothRemoteGATTCharacteristic,
  ) {
    // CoreBluetooth permits one GATT operation at a time. Bluefy can wedge the
    // peripheral if several stop requests race the final subscription.
    for (const { characteristic } of notifying) {
      if (characteristic === keep) continue;
      try {
        await characteristic.stopNotifications();
      } catch {
        /* a characteristic that refused start has nothing to stop */
      }
    }
  }

  private async attachBattery(server: BluetoothRemoteGATTServer) {
    try {
      const service = await server.getPrimaryService(BATTERY_SERVICE);
      const characteristic = await service.getCharacteristic(BATTERY_LEVEL);
      this.batteryChar = characteristic;
      const value = await characteristic.readValue();
      this.batteryCb?.(value.getUint8(0));
      if (characteristic.properties.notify) {
        this.batteryListener = (event) => {
          const v = (event.target as BluetoothRemoteGATTCharacteristic).value;
          if (v) this.batteryCb?.(v.getUint8(0));
        };
        characteristic.addEventListener("characteristicvaluechanged", this.batteryListener);
        await characteristic.startNotifications();
      }
    } catch {
      this.detachBattery();
    }
  }

  private detachBattery() {
    if (this.batteryChar && this.batteryListener) {
      this.batteryChar.removeEventListener("characteristicvaluechanged", this.batteryListener);
      void this.batteryChar.stopNotifications().catch(() => {});
    }
    this.batteryListener = null;
    this.batteryChar = null;
  }

  /** Montage for the mapped stream, with the FocusCalm caveats when it fits. */
  private buildProfile(map: ChannelMap, sampleRate: number): DeviceProfile {
    const mapped = (Object.keys(map) as (keyof ChannelMap)[]).filter((c) => map[c]);
    const looksFocusCalm = /focus|brainco|regul8/i.test(this.name);
    if (looksFocusCalm && mapped.length === 1 && mapped[0] === "AF7") {
      return {
        ...FOCUSCALM_PROFILE,
        label: this.name,
        sampleRate,
        calibratedAmplitude: Boolean(this.options.uvPerCount),
        capabilities: { ...FOCUSCALM_PROFILE.capabilities, battery: Boolean(this.batteryChar) },
      };
    }
    const generic = profileFromChannelMap({
      id: "ble-headset",
      label: this.name,
      sampleRate,
      map: Object.fromEntries(mapped.map((c) => [c, this.name])) as ChannelMap,
      transport: "ble",
    });
    generic.calibratedAmplitude = Boolean(this.options.uvPerCount);
    generic.capabilities = { ...generic.capabilities, battery: Boolean(this.batteryChar) };
    return generic;
  }

  /** µV per count in force, so the panel can show the calibration state. */
  get uvPerCount(): number {
    return this.scale;
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    this.reconnecting = false;
    this.retryWake?.();
    this.settleWaiters(false);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.detachStream();
    this.detachBattery();
    if (this.device && this.disconnectListener) {
      this.device.removeEventListener("gattserverdisconnected", this.disconnectListener);
    }
    this.disconnectListener = null;
    this.samplesCb = null;
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
  }
}
