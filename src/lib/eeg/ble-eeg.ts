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

import {
  FOCUSCALM_PROFILE,
  profileFromChannelMap,
  type DeviceProfile,
} from "@/lib/eeg/device-profile";
import { IngestPipeline, type ChannelMap, type IngestConfig } from "@/lib/eeg/ingest";
import {
  isWebBluetoothAvailable,
  WEB_BLUETOOTH_HELP,
  type EegSource,
  type SampleHandler,
  type SourceStateHandler,
} from "@/lib/eeg/muse";

/** Advertised-name hints for headsets known to work through this path. */
export const BLE_NAME_HINTS = ["FocusCalm", "Focus", "BrainCo", "Crimson", "Mind", "EEG"];

/**
 * Services requested up front. Web Bluetooth only lets an app read services it
 * asked for at pairing time, so this list has to cover the plausible layouts
 * before the device is seen: Nordic UART (the usual transport for BrainCo-style
 * firmware), the common 16-bit vendor ranges, and the standard battery and
 * device-information services.
 */
export const BLE_CANDIDATE_SERVICES: string[] = [
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "0000ffb0-0000-1000-8000-00805f9b34fb",
  "0000fee0-0000-1000-8000-00805f9b34fb",
  "0000fe8d-0000-1000-8000-00805f9b34fb", // Muse, harmless to include
  "0000180f-0000-1000-8000-00805f9b34fb", // battery
  "0000180a-0000-1000-8000-00805f9b34fb", // device information
];

const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
const BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb";

/* ------------------------------------------------------------------ */
/* Packet decoding                                                     */
/* ------------------------------------------------------------------ */

export type PacketFormat =
  | "brainco-int24be"
  | "brainco-int16le"
  | "int16le"
  | "int16be"
  | "int24be"
  | "int24le"
  | "float32le";

export const PACKET_FORMAT_LABEL: Record<PacketFormat, string> = {
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
 * Opens the pairing chooser. Name-filtered first so the known bands are easy
 * to spot, then accept-all so a headband advertising a nonstandard name (or
 * hiding it, as iOS does before bonding) is still reachable.
 */
export async function requestBleHeadset(extraServices: string[] = []): Promise<BluetoothDevice> {
  if (!isWebBluetoothAvailable()) throw new Error(WEB_BLUETOOTH_HELP);
  const optionalServices = [...new Set([...BLE_CANDIDATE_SERVICES, ...extraServices])];
  try {
    return await navigator.bluetooth.requestDevice({
      filters: BLE_NAME_HINTS.map((namePrefix) => ({ namePrefix })),
      optionalServices,
    });
  } catch (error) {
    const cancelled = /cancel/i.test((error as Error)?.message ?? "");
    if (error instanceof DOMException && error.name === "NotFoundError" && !cancelled) {
      return await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
    }
    throw error;
  }
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
}

const COLUMN = "ble";

/**
 * A discovered BLE EEG stream presented as an ordinary `EegSource`, so the
 * monitor, lineage gating and every downstream metric treat it exactly like
 * any other non-Muse amplifier.
 */
export class BleHeadsetSource implements EegSource {
  name = "BLE headset";
  profile: DeviceProfile = FOCUSCALM_PROFILE;
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  private pipeline: IngestPipeline | null = null;
  private format: PacketFormat = "int16le";
  private scale = 1;
  private stopping = false;
  private listener: ((event: Event) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private stateCb: SourceStateHandler | null = null;
  private batteryCb: ((percent: number) => void) | null = null;
  private discoveryCb: ((d: BleDiscovery) => void) | null = null;
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

  async start(onSamples: SampleHandler) {
    if (!isWebBluetoothAvailable()) throw new Error(WEB_BLUETOOTH_HELP);
    this.stopping = false;
    const device = this.options.device ?? (await requestBleHeadset(this.options.extraServices));
    this.device = device;
    this.name = this.options.label ?? device.name ?? "BLE headset";
    device.addEventListener("gattserverdisconnected", () => {
      if (this.stopping) return;
      this.stateCb?.({ kind: "lost", reason: "The headset disconnected." });
      this.disconnectCb?.();
    });

    const server = await device.gatt?.connect();
    if (!server) throw new Error("Could not open a GATT connection to the headset.");

    const services = await server.getPrimaryServices();
    if (!services.length)
      throw new Error(
        "The headset exposed no readable services. Make sure it is not connected to the FocusCalm phone app at the same time.",
      );

    await this.attachBattery(server);

    const notifying: {
      service: BluetoothRemoteGATTService;
      characteristic: BluetoothRemoteGATTCharacteristic;
    }[] = [];
    for (const service of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await service.getCharacteristics();
      } catch {
        continue;
      }
      for (const characteristic of chars) {
        if (characteristic.properties.notify || characteristic.properties.indicate) {
          notifying.push({ service, characteristic });
        }
      }
    }
    if (!notifying.length)
      throw new Error("No streaming characteristic was found on this headset.");

    const listenMs = Math.max(1_000, (this.options.listenSeconds ?? 3) * 1000);
    const captured = await this.listen(notifying, listenMs);
    const chosen = this.choose(captured, listenMs / 1000);
    if (!chosen)
      throw new Error(
        "The headset connected but no stream decoded as EEG. Check the band is worn and powered, and that no other app holds the connection.",
      );

    this.format = chosen.discovery.format;
    const measuredRate = this.options.sampleRate ?? chosen.discovery.sampleRate;
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
    this.pipeline = new IngestPipeline(config, onSamples);
    if (this.pipeline.mappedCount === 0)
      throw new Error("Map the headset stream onto at least one analysis electrode.");

    // Re-subscribe to the winning characteristic only.
    await this.detachAll(notifying, chosen.characteristic);
    this.characteristic = chosen.characteristic;
    this.listener = (event: Event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (!value) return;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const decoded = decodePacket(this.format, bytes);
      if (!decoded.length) return;
      this.pipeline?.push({ [COLUMN]: Float64Array.from(decoded) });
    };
    this.characteristic.addEventListener("characteristicvaluechanged", this.listener);
    this.discovery = { ...chosen.discovery, uvPerCount, sampleRate: measuredRate };
    this.discoveryCb?.(this.discovery);
    this.stateCb?.({ kind: "connected" });
  }

  /** Subscribes to everything that notifies and collects a burst of packets. */
  private async listen(
    notifying: {
      service: BluetoothRemoteGATTService;
      characteristic: BluetoothRemoteGATTCharacteristic;
    }[],
    listenMs: number,
  ) {
    const captured = new Map<
      string,
      {
        service: BluetoothRemoteGATTService;
        characteristic: BluetoothRemoteGATTCharacteristic;
        packets: Uint8Array[];
      }
    >();
    const handlers: [BluetoothRemoteGATTCharacteristic, (e: Event) => void][] = [];
    for (const entry of notifying) {
      const key = entry.characteristic.uuid;
      captured.set(key, { ...entry, packets: [] });
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
      } catch {
        /* some characteristics refuse; the others still answer */
      }
    }
    await new Promise((r) => setTimeout(r, listenMs));
    for (const [characteristic, handler] of handlers) {
      characteristic.removeEventListener("characteristicvaluechanged", handler);
    }
    return [...captured.values()];
  }

  /** Picks the most EEG-like stream from the captured burst. */
  private choose(
    captured: {
      service: BluetoothRemoteGATTService;
      characteristic: BluetoothRemoteGATTCharacteristic;
      packets: Uint8Array[];
    }[],
    seconds: number,
  ) {
    const candidates: BleDiscovery["candidates"] = [];
    let best: {
      characteristic: BluetoothRemoteGATTCharacteristic;
      discovery: BleDiscovery;
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
        serviceUuid: entry.service.uuid,
        characteristicUuid: entry.characteristic.uuid,
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
        best = { characteristic: entry.characteristic, discovery };
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
    for (const { characteristic } of notifying) {
      if (characteristic === keep) continue;
      try {
        await characteristic.stopNotifications();
      } catch {
        /* ignore */
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
        characteristic.addEventListener("characteristicvaluechanged", (event) => {
          const v = (event.target as BluetoothRemoteGATTCharacteristic).value;
          if (v) this.batteryCb?.(v.getUint8(0));
        });
        await characteristic.startNotifications();
      }
    } catch {
      this.batteryChar = null;
    }
  }

  /** Montage for the mapped stream, with the FocusCalm caveats when it fits. */
  private buildProfile(map: ChannelMap, sampleRate: number): DeviceProfile {
    const mapped = (Object.keys(map) as (keyof ChannelMap)[]).filter((c) => map[c]);
    const looksFocusCalm = /focus|brainco/i.test(this.name);
    if (looksFocusCalm && mapped.length === 1 && mapped[0] === "AF7") {
      return { ...FOCUSCALM_PROFILE, label: this.name, sampleRate };
    }
    return profileFromChannelMap({
      id: "ble-headset",
      label: this.name,
      sampleRate,
      map: Object.fromEntries(mapped.map((c) => [c, this.name])) as ChannelMap,
      transport: "ble",
    });
  }

  /** µV per count in force, so the panel can show the calibration state. */
  get uvPerCount(): number {
    return this.scale;
  }

  async stop() {
    this.stopping = true;
    if (this.characteristic && this.listener) {
      this.characteristic.removeEventListener("characteristicvaluechanged", this.listener);
      try {
        await this.characteristic.stopNotifications();
      } catch {
        /* ignore */
      }
    }
    this.listener = null;
    this.characteristic = null;
    this.batteryChar = null;
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
  }
}
