/// <reference types="web-bluetooth" />
/**
 * "Identify headband" — a non-destructive Bluetooth survey.
 *
 * The streaming path in `ble-eeg.ts` has one job: get a usable EEG stream or
 * fail. That is the right behaviour at the bedside, but it is the wrong tool
 * for a band whose protocol nobody has observed: every failed attempt throws
 * away the evidence needed to work out *why* it failed.
 *
 * This module connects, writes nothing unless explicitly asked, and always
 * produces a report: the device's own identity strings, its complete GATT map,
 * the contents of every readable characteristic, and a long observation window
 * recording exactly which characteristics send data, how fast, and whether any
 * of it decodes as EEG.
 *
 * The optional activation probe (stage 4) is separate, explicitly started, and
 * only ever sends documented BrainCo/Nordic sequences one at a time with an
 * observation window after each, so the log shows which sequence — if any —
 * made the band talk.
 */

import { bleDiagnostics, toHex } from "@/lib/eeg/ble-diagnostics";
import {
  autoScaleUvPerCount,
  decodePacket,
  detectPacketFormat,
  isIosWebBleBrowser,
  PACKET_FORMAT_LABEL,
  requestBleHeadset,
  type PacketFormat,
} from "@/lib/eeg/ble-eeg";
import { ANALYSIS_SAMPLE_RATE } from "@/lib/eeg/device-profile";
import { resample } from "@/lib/eeg/ingest";
import { analyseStreamTest, type StreamTestResult } from "@/lib/eeg/stream-test";

import {
  nextZenLiteMsgId,
  zenliteAfeCommand,
  zenlitePairCommand,
  zenlitePairUuid,
  zenliteSysCommand,
  ZENLITE_AFE,
  ZENLITE_CMD,
  ZENLITE_NOTIFY,
  ZENLITE_SERVICE,
  ZENLITE_WRITE,
  ZENLITE_TRANSPORTS,
  isZenLiteNotify,
  isZenLiteService,
  zenliteTransportForService,
  ZENLITE_UV_PER_COUNT,
  zenliteSampleRateFromEnum,
  zenliteStreamInfo,

} from "@/lib/eeg/brainco-zenlite";

/**
 * Turns the captured observation window into the same spectral array the
 * monitor draws, and checks the rate the firmware declares against the rate it
 * actually delivered. A first capture therefore verifies itself instead of
 * relying on an assumed 256 Hz.
 */
function buildPreview(
  report: BleIdentifyReport,
  watchers: Watcher[],
  elapsedSeconds: number,
  progress: (message: string) => void,
) {
  const best = watchers
    .filter((w) => w.packets.length && (w.report.bestScore ?? 0) >= 0.6 && w.report.bestFormat)
    .sort((a, b) => (b.report.bestScore ?? 0) - (a.report.bestScore ?? 0))[0];
  if (!best) return;

  progress("Building the spectral preview");
  const format = best.report.bestFormat as PacketFormat;
  const counts: number[] = [];
  for (const packet of best.packets) counts.push(...decodePacket(format, packet));
  if (counts.length < 64) return;

  // The firmware states its own rate inside each AFE frame; trust that when it
  // is present and consistent with what arrived.
  let declaredHz: number | null = null;
  let declaredEnum: number | null = null;
  if (format === "brainco-zenlite") {
    const rates = new Map<number, number>();
    for (const packet of best.packets) {
      for (const info of zenliteStreamInfo(packet)) {
        if (info.sampleRateEnum == null) continue;
        rates.set(info.sampleRateEnum, (rates.get(info.sampleRateEnum) ?? 0) + 1);
      }
    }
    const top = [...rates.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      declaredEnum = top[0];
      declaredHz = zenliteSampleRateFromEnum(top[0]);
    }
  }

  const seconds = Math.max(1, elapsedSeconds);
  const observedHz = Number((counts.length / seconds).toFixed(1));
  const agrees =
    declaredHz != null && Math.abs(observedHz - declaredHz) <= 0.15 * declaredHz;
  const usedHz = Math.max(32, Math.round(agrees && declaredHz ? declaredHz : observedHz));

  report.sampleRate = {
    declaredHz,
    declaredEnum,
    observedHz,
    usedHz,
    agrees,
    detail:
      declaredHz == null
        ? `The band declares no rate, so the measured ${observedHz} Hz was used.`
        : agrees
          ? `Firmware declares ${declaredHz} Hz and delivered ${observedHz} Hz — verified.`
          : `Firmware declares ${declaredHz} Hz but delivered ${observedHz} Hz; the measured rate was used and packets are probably being dropped.`,
  };

  const uvPerCount =
    format === "brainco-zenlite"
      ? ZENLITE_UV_PER_COUNT
      : autoScaleUvPerCount(
          [...counts].map(Math.abs).sort((a, b) => a - b)[
            Math.floor(counts.length * 0.95)
          ] ?? 1,
        );
  const microvolts = Float64Array.from(counts, (c) => c * uvPerCount);
  const signal = resample(microvolts, usedHz, ANALYSIS_SAMPLE_RATE);
  if (signal.length < ANALYSIS_SAMPLE_RATE) return;

  report.previewCharacteristic = best.report.characteristicUuid;
  report.preview = analyseStreamTest(signal, {
    sampleRate: ANALYSIS_SAMPLE_RATE,
    expectedRate: ANALYSIS_SAMPLE_RATE,
    captureSeconds: signal.length / ANALYSIS_SAMPLE_RATE,
    packets: best.report.packets,
  });
  bleDiagnostics.add("session", "Identify preview computed", {
    characteristic: best.report.characteristicUuid,
    usedHz,
    declaredHz,
    observedHz,
    passed: report.preview.passed,
  });
}


const DEVICE_INFORMATION_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb";
const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
const BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb";
const NORDIC_UART = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";

const DEVICE_INFO_FIELDS: Array<[string, string]> = [
  ["00002a29-0000-1000-8000-00805f9b34fb", "Manufacturer"],
  ["00002a24-0000-1000-8000-00805f9b34fb", "Model"],
  ["00002a25-0000-1000-8000-00805f9b34fb", "Serial"],
  ["00002a27-0000-1000-8000-00805f9b34fb", "Hardware"],
  ["00002a26-0000-1000-8000-00805f9b34fb", "Firmware"],
  ["00002a28-0000-1000-8000-00805f9b34fb", "Software"],
];

export interface BleCharacteristicReport {
  serviceUuid: string;
  characteristicUuid: string;
  properties: string[];
  /** Value read once before observation, when the characteristic is readable. */
  readHex?: string;
  readText?: string;
  subscribed: boolean;
  subscriptionError?: string;
  packets: number;
  bytes: number;
  packetsPerSecond: number;
  firstPacketHex?: string;
  /** Best-scoring packet layout, when anything arrived. */
  bestFormat?: PacketFormat;
  bestFormatLabel?: string;
  bestScore?: number;
  decodedSamples?: number;
}

export type BleIdentifyStatus = "eeg" | "traffic" | "silent" | "no-notify" | "no-services";

export interface BleActivationProbeStep {
  name: string;
  detail: string;
  serviceUuid: string;
  characteristicUuid: string;
  sentHex: string;
  written: boolean;
  writeError?: string;
  /** Packets seen across all subscribed characteristics after this write. */
  packetsAfter: number;
  bytesAfter: number;
  respondingCharacteristics: string[];
}

export interface BleSampleRateCheck {
  /** Rate the firmware declared inside its own AFE frames, when it does. */
  declaredHz: number | null;
  /** Raw sample-rate enum value seen in the frames. */
  declaredEnum: number | null;
  /** Samples per second actually delivered during the observation window. */
  observedHz: number;
  /** Rate used for the spectral preview. */
  usedHz: number;
  /** True when the declared rate and the delivered rate agree within 15%. */
  agrees: boolean;
  detail: string;
}

export interface BleIdentifyReport {
  deviceName: string;
  startedAt: number;
  watchedSeconds: number;
  ios: boolean;
  information: Record<string, string>;
  batteryPercent: number | null;
  services: string[];
  characteristics: BleCharacteristicReport[];
  probe: BleActivationProbeStep[];
  status: BleIdentifyStatus;
  summary: string;
  advice: string;
  /** Sample-rate verification from the captured session, when EEG decoded. */
  sampleRate?: BleSampleRateCheck;
  /** Spectral array produced from the captured session, when EEG decoded. */
  preview?: StreamTestResult;
  /** Characteristic the preview was computed from. */
  previewCharacteristic?: string;
}


export interface BleIdentifyOptions {
  /** Seconds spent silently watching every notifying characteristic. */
  watchSeconds?: number;
  /** Runs the documented BrainCo/Nordic activation sequences (writes to the band). */
  probeActivation?: boolean;
  /** Reuse an already-chosen device instead of opening the chooser. */
  device?: BluetoothDevice;
  onProgress?: (message: string) => void;
}

interface Watcher {
  report: BleCharacteristicReport;
  characteristic: BluetoothRemoteGATTCharacteristic;
  packets: Uint8Array[];
  handler: (event: Event) => void;
  /** Packet count at the start of the current probe step. */
  mark: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeText(view: DataView): string | undefined {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let text = "";
  for (const byte of bytes) {
    if (byte === 0) continue;
    if (byte < 0x20 || byte > 0x7e) return undefined;
    text += String.fromCharCode(byte);
  }
  return text.trim() || undefined;
}

async function connectWithRetries(device: BluetoothDevice, ios: boolean) {
  const gatt = device.gatt;
  if (!gatt) throw new Error("The selected device does not expose a Bluetooth GATT connection.");
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep((ios ? 1_500 : 700) * attempt);
      const server = await gatt.connect();
      const settleUntil = Date.now() + (ios ? 4_000 : 500);
      while (!server.connected && Date.now() < settleUntil) await sleep(100);
      if (server.connected) return server;
      lastError = new Error("Could not open a GATT connection to the headset.");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not open a GATT connection to the headset.");
}

/**
 * Documented sequences, tried one at a time. Nothing here is invented: the
 * BrainCo frames are the ones published in the OxyZen SDK documentation and
 * already used by the streaming path, and the Nordic UART strings are the
 * conventional start tokens for a UART-transport band.
 */
function buildProbeSteps(): Array<{ name: string; detail: string; service: string; bytes: Uint8Array }> {
  const uuid = zenlitePairUuid();
  return [
    {
      name: "BrainCo validate pairing",
      detail: "Confirms an existing pairing without re-pairing the band.",
      service: ZENLITE_SERVICE,
      bytes: zenlitePairCommand(nextZenLiteMsgId(), false, uuid),
    },
    {
      name: "BrainCo pair",
      detail: "Performs a first-time pairing handshake.",
      service: ZENLITE_SERVICE,
      bytes: zenlitePairCommand(nextZenLiteMsgId(), true, uuid),
    },
    {
      name: "BrainCo system monitor",
      detail: "Harmless status request; proves the command channel works.",
      service: ZENLITE_SERVICE,
      bytes: zenliteSysCommand(nextZenLiteMsgId(), ZENLITE_CMD.getSystemMonitor),
    },
    {
      name: "BrainCo AFE on, 256 Hz",
      detail: "Switches the EEG front end on at the documented rate.",
      service: ZENLITE_SERVICE,
      bytes: zenliteAfeCommand(nextZenLiteMsgId(), ZENLITE_AFE.sr256),
    },
    {
      name: "BrainCo AFE on, 128 Hz",
      detail: "Same, at the alternative published rate.",
      service: ZENLITE_SERVICE,
      bytes: zenliteAfeCommand(nextZenLiteMsgId(), ZENLITE_AFE.sr128),
    },
    {
      name: "Nordic UART start token",
      detail: "Conventional plain-text start command on a UART-transport band.",
      service: NORDIC_UART,
      bytes: new TextEncoder().encode("start\r\n"),
    },
  ];
}

/**
 * Connects, surveys and reports. This never throws because the band failed to
 * stream — only because the link itself could not be opened.
 */
export async function identifyBleHeadset(
  options: BleIdentifyOptions = {},
): Promise<BleIdentifyReport> {
  const watchSeconds = Math.min(120, Math.max(5, options.watchSeconds ?? 30));
  const ios = isIosWebBleBrowser();
  const progress = options.onProgress ?? (() => {});

  progress("Choosing the headband");
  const device = options.device ?? (await requestBleHeadset());
  const deviceName = device.name ?? "Unnamed headband";
  bleDiagnostics.add("session", `Identify run started for ${deviceName}`, { watchSeconds, ios });

  const report: BleIdentifyReport = {
    deviceName,
    startedAt: Date.now(),
    watchedSeconds: watchSeconds,
    ios,
    information: {},
    batteryPercent: null,
    services: [],
    characteristics: [],
    probe: [],
    status: "no-services",
    summary: "",
    advice: "",
  };

  progress(`Connecting to ${deviceName}`);
  const server = await connectWithRetries(device, ios);
  const watchers: Watcher[] = [];

  try {
    progress("Listing everything the band exposes");
    let services: BluetoothRemoteGATTService[] = [];
    for (let attempt = 0; attempt < 3 && !services.length; attempt++) {
      if (attempt > 0) await sleep(500);
      try {
        services = await server.getPrimaryServices();
      } catch {
        services = [];
      }
    }
    report.services = services.map((service) => service.uuid);
    bleDiagnostics.add("service", `Identify: ${services.length} primary service(s)`, {
      services: report.services,
    });

    // Identity strings first — these are the single most useful thing for
    // working out which vendor firmware is actually running.
    for (const service of services) {
      if (service.uuid !== DEVICE_INFORMATION_SERVICE) continue;
      for (const [uuid, label] of DEVICE_INFO_FIELDS) {
        try {
          const value = await service.getCharacteristic(uuid).then((c) => c.readValue());
          const text = decodeText(value);
          if (text) report.information[label] = text;
        } catch {
          /* Not every band publishes every field. */
        }
      }
    }
    try {
      const battery = await server
        .getPrimaryService(BATTERY_SERVICE)
        .then((service) => service.getCharacteristic(BATTERY_LEVEL))
        .then((characteristic) => characteristic.readValue());
      report.batteryPercent = battery.getUint8(0);
    } catch {
      /* Battery service is optional. */
    }

    // Full characteristic map, plus a single read of anything readable.
    const writable: Array<{
      service: BluetoothRemoteGATTService;
      characteristic: BluetoothRemoteGATTCharacteristic;
    }> = [];
    for (const service of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        chars = await service.getCharacteristics();
      } catch {
        continue;
      }
      for (const characteristic of chars) {
        const props = characteristic.properties;
        const entry: BleCharacteristicReport = {
          serviceUuid: service.uuid,
          characteristicUuid: characteristic.uuid,
          properties: Object.entries({
            read: props.read,
            write: props.write,
            writeWithoutResponse: props.writeWithoutResponse,
            notify: props.notify,
            indicate: props.indicate,
          })
            .filter(([, on]) => on)
            .map(([name]) => name),
          subscribed: false,
          packets: 0,
          bytes: 0,
          packetsPerSecond: 0,
        };
        if (props.read) {
          try {
            const value = await characteristic.readValue();
            const bytes = new Uint8Array(
              value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
            );
            entry.readHex = toHex(bytes);
            const text = decodeText(value);
            if (text) entry.readText = text;
          } catch {
            /* A readable characteristic can still refuse a read before start. */
          }
        }
        if (props.write || props.writeWithoutResponse) writable.push({ service, characteristic });
        report.characteristics.push(entry);
        if (props.notify || props.indicate) {
          watchers.push({
            report: entry,
            characteristic,
            packets: [],
            mark: 0,
            handler: () => {},
          });
        }
      }
    }

    if (!services.length) {
      report.status = "no-services";
      report.summary = "The band connected but exposed no services at all.";
      report.advice =
        "Close the FocusCalm app completely, unplug the charging cable, switch the band off and on, then run this again.";
      return report;
    }
    if (!watchers.length) {
      report.status = "no-notify";
      report.summary = `${services.length} service(s) found, but none of them can send data.`;
      report.advice =
        "The EEG service is usually only exposed after the band is in pairing mode. Hold the power button until the LED flashes blue, then run this again.";
      return report;
    }

    // Subscribe to everything, then simply watch.
    progress(`Subscribing to ${watchers.length} channel(s)`);
    for (const watcher of watchers) {
      const key = `${watcher.report.serviceUuid}/${watcher.report.characteristicUuid}`;
      watcher.handler = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const bytes = new Uint8Array(
          value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
        );
        watcher.report.packets++;
        watcher.report.bytes += bytes.length;
        if (!watcher.report.firstPacketHex) watcher.report.firstPacketHex = toHex(bytes);
        if (watcher.packets.length < 600) watcher.packets.push(bytes);
        bleDiagnostics.packet(key, bytes, "identify observation");
      };
      watcher.characteristic.addEventListener("characteristicvaluechanged", watcher.handler);
      try {
        await watcher.characteristic.startNotifications();
        watcher.report.subscribed = true;
      } catch (error) {
        watcher.report.subscriptionError =
          error instanceof Error ? error.message : String(error);
      }
      await sleep(60);
    }

    if (options.probeActivation) {
      report.probe = await runActivationProbe(services, writable, watchers, progress);
    }

    const observeMs = watchSeconds * 1000;
    const observeStart = Date.now();
    progress(`Watching for ${watchSeconds}s — sit still with the band on`);
    while (Date.now() - observeStart < observeMs) {
      await sleep(500);
      const elapsed = Math.round((Date.now() - observeStart) / 1000);
      const seen = watchers.reduce((sum, w) => sum + w.report.packets, 0);
      progress(`Watching (${elapsed}/${watchSeconds}s) — ${seen} packet(s) so far`);
    }

    const elapsedSeconds = (Date.now() - observeStart) / 1000;
    for (const watcher of watchers) {
      watcher.report.packetsPerSecond = Number(
        (watcher.report.packets / Math.max(1, elapsedSeconds)).toFixed(1),
      );
      if (!watcher.packets.length) continue;
      const best = detectPacketFormat(watcher.packets)[0];
      if (best) {
        watcher.report.bestFormat = best.format;
        watcher.report.bestFormatLabel = PACKET_FORMAT_LABEL[best.format];
        watcher.report.bestScore = Number(best.score.toFixed(2));
        watcher.report.decodedSamples = Math.round(
          best.samplesPerPacket * watcher.packets.length,
        );
      }
    }

    buildPreview(report, watchers, elapsedSeconds, progress);
    summarise(report);
    return report;

  } finally {
    for (const watcher of watchers) {
      watcher.characteristic.removeEventListener("characteristicvaluechanged", watcher.handler);
      try {
        await watcher.characteristic.stopNotifications();
      } catch {
        /* The link may already be gone. */
      }
    }
    try {
      device.gatt?.disconnect();
    } catch {
      /* Already closed. */
    }
    bleDiagnostics.add("session", "Identify run finished", {
      status: report.status,
      packets: report.characteristics.reduce((sum, c) => sum + c.packets, 0),
    });
  }
}

/** Writes each documented sequence once, watching for a reply after each. */
async function runActivationProbe(
  services: BluetoothRemoteGATTService[],
  writable: Array<{
    service: BluetoothRemoteGATTService;
    characteristic: BluetoothRemoteGATTCharacteristic;
  }>,
  watchers: Watcher[],
  progress: (message: string) => void,
): Promise<BleActivationProbeStep[]> {
  const steps: BleActivationProbeStep[] = [];
  const byService = new Map(services.map((service) => [service.uuid.toLowerCase(), service]));

  for (const candidate of buildProbeSteps()) {
    // BrainCo steps are written to whichever vendor transport this firmware
    // actually exposes (OxyZen 4DE5xxxx or FocusCalm FC-11 0D74xxxx).
    const service = isZenLiteService(candidate.service)
      ? (ZENLITE_TRANSPORTS.map((t) => byService.get(t.service)).find(Boolean) ?? undefined)
      : byService.get(candidate.service.toLowerCase());
    // Prefer the documented write characteristic of that service; otherwise
    // fall back to whatever writable characteristic that service exposes.
    let target: BluetoothRemoteGATTCharacteristic | null = null;
    if (service) {
      try {
        const transport = zenliteTransportForService(service.uuid);
        target = transport ? await service.getCharacteristic(transport.write) : null;
      } catch {
        target = null;
      }
      if (!target) {
        target =
          writable.find(
            (entry) => entry.service.uuid.toLowerCase() === service.uuid.toLowerCase(),
          )?.characteristic ?? null;
      }
    }

    if (!target) continue;

    for (const watcher of watchers) watcher.mark = watcher.report.packets;
    const step: BleActivationProbeStep = {
      name: candidate.name,
      detail: candidate.detail,
      serviceUuid: service?.uuid ?? candidate.service,
      characteristicUuid: target.uuid,
      sentHex: toHex(candidate.bytes),
      written: false,
      packetsAfter: 0,
      bytesAfter: 0,
      respondingCharacteristics: [],
    };
    progress(`Probing: ${candidate.name}`);
    bleDiagnostics.add(
      "command",
      `Probe: ${candidate.name}`,
      { characteristic: target.uuid },
      candidate.bytes,
    );
    try {
      if (target.properties.write) await target.writeValue(candidate.bytes as BufferSource);
      else await target.writeValueWithoutResponse(candidate.bytes as BufferSource);
      step.written = true;
    } catch (error) {
      step.writeError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_500);
    for (const watcher of watchers) {
      const gained = watcher.report.packets - watcher.mark;
      if (gained <= 0) continue;
      step.packetsAfter += gained;
      step.respondingCharacteristics.push(watcher.report.characteristicUuid);
    }
    steps.push(step);
  }
  return steps;
}

function summarise(report: BleIdentifyReport) {
  const active = report.characteristics.filter((entry) => entry.packets > 0);
  const eeg = active.filter((entry) => (entry.bestScore ?? 0) >= 0.6);
  const hasZenLite = report.characteristics.some(
    (entry) => isZenLiteNotify(entry.characteristicUuid),
  );

  if (eeg.length) {
    const best = eeg.sort((a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0))[0]!;
    report.status = "eeg";
    report.summary = `Readable EEG found on ${best.characteristicUuid} as ${best.bestFormatLabel} (confidence ${best.bestScore}).`;
    report.advice = "Close this and start a case or the stream test — the band should now stream.";
    return;
  }
  if (active.length) {
    report.status = "traffic";
    report.summary = `${active.length} channel(s) sent data (${active
      .map((entry) => `${entry.characteristicUuid.slice(4, 8)}: ${entry.packets}`)
      .join(", ")}) but none of it decoded as EEG.`;
    report.advice =
      "The band is talking, so this is a decoding problem rather than a pairing one. Export this report — the packet bytes in it are what is needed to work out the layout.";
    return;
  }
  report.status = "silent";
  report.summary = `${report.characteristics.filter((entry) => entry.subscribed).length} channel(s) subscribed successfully, but the band sent nothing at all in ${report.watchedSeconds}s.`;
  report.advice = hasZenLite
    ? "The BrainCo data channel is present but idle, which means the band needs an activation command it has not received. Run the survey again with the activation probe switched on."
    : "No BrainCo data channel was exposed. Put the band in pairing mode (LED flashing blue) with the FocusCalm app fully closed, then run this again.";
}

/** Plain-text export of a survey, safe to send from a phone. */
export function formatIdentifyReport(report: BleIdentifyReport): string {
  const lines: string[] = [];
  lines.push(`Headband survey — ${report.deviceName}`);
  lines.push(new Date(report.startedAt).toISOString());
  lines.push(`Browser: ${report.ios ? "iOS Web Bluetooth bridge" : "desktop/Android"}`);
  lines.push("");
  lines.push(`Verdict: ${report.status} — ${report.summary}`);
  lines.push(report.advice);
  lines.push("");
  if (Object.keys(report.information).length) {
    lines.push("Device information");
    for (const [key, value] of Object.entries(report.information)) lines.push(`  ${key}: ${value}`);
  }
  if (report.batteryPercent != null) lines.push(`  Battery: ${report.batteryPercent}%`);
  lines.push("");
  lines.push(`Services (${report.services.length})`);
  for (const uuid of report.services) lines.push(`  ${uuid}`);
  lines.push("");
  lines.push(`Characteristics (${report.characteristics.length})`);
  for (const entry of report.characteristics) {
    lines.push(`  ${entry.serviceUuid} / ${entry.characteristicUuid}`);
    lines.push(`    properties: ${entry.properties.join(", ") || "none"}`);
    if (entry.readHex) lines.push(`    read: ${entry.readHex}`);
    if (entry.readText) lines.push(`    text: ${entry.readText}`);
    if (entry.subscriptionError) lines.push(`    subscription failed: ${entry.subscriptionError}`);
    else if (entry.subscribed) {
      lines.push(
        `    packets: ${entry.packets} (${entry.packetsPerSecond}/s, ${entry.bytes} bytes)`,
      );
      if (entry.firstPacketHex) lines.push(`    first packet: ${entry.firstPacketHex}`);
      if (entry.bestFormat)
        lines.push(
          `    best layout: ${entry.bestFormatLabel} score ${entry.bestScore} (${entry.decodedSamples} samples)`,
        );
    }
  }
  if (report.probe.length) {
    lines.push("");
    lines.push("Activation probe");
    for (const step of report.probe) {
      lines.push(`  ${step.name} → ${step.characteristicUuid}`);
      lines.push(`    sent: ${step.sentHex}`);
      lines.push(
        step.written
          ? `    reply: ${step.packetsAfter} packet(s)${step.respondingCharacteristics.length ? ` on ${step.respondingCharacteristics.join(", ")}` : ""}`
          : `    write failed: ${step.writeError}`,
      );
    }
  }
  return lines.join("\n");
}
