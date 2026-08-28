import { describe, expect, it } from "vitest";

import {
  BLE_CANDIDATE_SERVICES,
  BLE_NAME_HINTS,
  IOS_BLE_CANDIDATE_SERVICES,
  WEB_BLUETOOTH_BLOCKED_SERVICES,
  autoScaleUvPerCount,
  decodePacket,
  detectPacketFormat,
  eegLikeness,
  friendlyBleError,
  isIosWebBleBrowser,
  stripBrainCoFrames,
} from "@/lib/eeg/ble-eeg";

/** Smooth, oversampled series with the temporal structure of scalp EEG. */
function eegCounts(n: number, amplitude = 8000): number[] {
  const out: number[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    const t = i / 250;
    x = 0.9 * x + 0.1 * (Math.random() - 0.5);
    out.push(
      Math.round(
        amplitude * (0.6 * Math.sin(2 * Math.PI * 10 * t) + 0.3 * Math.sin(2 * Math.PI * 3 * t) + x),
      ),
    );
  }
  return out;
}

function packetsInt16le(samples: number[], perPacket = 20): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i += perPacket) {
    const slice = samples.slice(i, i + perPacket);
    const bytes = new Uint8Array(slice.length * 2);
    const view = new DataView(bytes.buffer);
    slice.forEach((v, k) => view.setInt16(k * 2, Math.max(-32768, Math.min(32767, v)), true));
    packets.push(bytes);
  }
  return packets;
}

function brainCoPackets(samples: number[], perPacket = 15): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i += perPacket) {
    const slice = samples.slice(i, i + perPacket);
    const payload: number[] = [];
    for (const v of slice) {
      const raw = (v < 0 ? v + 0x1000000 : v) & 0xffffff;
      payload.push((raw >> 16) & 0xff, (raw >> 8) & 0xff, raw & 0xff);
    }
    packets.push(Uint8Array.from([0x55, 0xaa, payload.length + 1, 0x11, ...payload, 0x00]));
  }
  return packets;
}

describe("BLE headset decoding", () => {
  it("recognises the Regul8 product name", () => {
    expect(BLE_NAME_HINTS).toContain("Regul8");
  });

  it("authorises standard and short vendor services used by headbands", () => {
    expect(BLE_CANDIDATE_SERVICES).toContain("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    expect(BLE_CANDIDATE_SERVICES).toContain("0000180f-0000-1000-8000-00805f9b34fb");
    expect(BLE_CANDIDATE_SERVICES).toContain("0000fff0-0000-1000-8000-00805f9b34fb");
  });

  it("never sends a browser-blocked service to the Bluetooth chooser", () => {
    expect(BLE_CANDIDATE_SERVICES).not.toContain("00001812-0000-1000-8000-00805f9b34fb");
    expect(
      BLE_CANDIDATE_SERVICES.filter((uuid) => WEB_BLUETOOTH_BLOCKED_SERVICES.has(uuid)),
    ).toEqual([]);
  });

  it("keeps the iOS service request small enough for Web BLE bridges", () => {
    expect(IOS_BLE_CANDIDATE_SERVICES.length).toBeLessThanOrEqual(10);
    expect(IOS_BLE_CANDIDATE_SERVICES).toContain("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
  });

  it("recognises iPhone and touch-capable iPad user agents", () => {
    const originalAgent = navigator.userAgent;
    const originalTouches = navigator.maxTouchPoints;
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Bluefy iPhone" });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    expect(isIosWebBleBrowser()).toBe(true);
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalAgent });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: originalTouches });
  });

  it("recognises the serial-like FC- names used by some FocusCalm units", () => {
    expect(BLE_NAME_HINTS).toContain("FC-");
  });

  it("recovers BrainCo-framed payloads and drops the header and checksum", () => {
    const framed = Uint8Array.from([0x55, 0xaa, 0x04, 0x11, 1, 2, 3, 0xff]);
    expect(Array.from(stripBrainCoFrames(framed) ?? [])).toEqual([]);
    const two = Uint8Array.from([
      0x55, 0xaa, 0x07, 0x11, 1, 2, 3, 4, 5, 6, 0xff, 0x55, 0xaa, 0x07, 0x11, 7, 8, 9, 10, 11, 12,
      0xff,
    ]);
    expect(Array.from(stripBrainCoFrames(two) ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("returns null when the buffer is not BrainCo-framed", () => {
    expect(stripBrainCoFrames(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it("decodes signed 24-bit samples including negatives", () => {
    const bytes = Uint8Array.from([0x00, 0x00, 0x0a, 0xff, 0xff, 0xf6]);
    expect(decodePacket("int24be", bytes)).toEqual([10, -10]);
  });

  it("scores an EEG-like series far above shredded bytes", () => {
    const eeg = eegCounts(1000);
    const noise = eeg.map(() => Math.round((Math.random() - 0.5) * 20000));
    expect(eegLikeness(eeg)).toBeGreaterThan(0.8);
    expect(eegLikeness(noise)).toBeLessThan(0.3);
  });

  it("identifies a raw int16 little-endian stream", () => {
    const best = detectPacketFormat(packetsInt16le(eegCounts(1200)))[0];
    expect(best?.format).toBe("int16le");
    expect(best?.score).toBeGreaterThan(0.8);
    expect(best?.samplesPerPacket).toBeCloseTo(20, 0);
  });

  it("identifies a BrainCo-framed 24-bit stream", () => {
    const best = detectPacketFormat(brainCoPackets(eegCounts(900, 40000)))[0];
    expect(best?.format).toBe("brainco-int24be");
    expect(best?.score).toBeGreaterThan(0.8);
  });

  it("rejects a non-EEG notification stream", () => {
    const packets = Array.from({ length: 40 }, () =>
      Uint8Array.from(Array.from({ length: 20 }, () => Math.floor(Math.random() * 256))),
    );
    const best = detectPacketFormat(packets)[0];
    expect(best ? best.score : 0).toBeLessThan(0.6);
  });

  it("auto-gains implausible counts onto scalp amplitude and leaves µV alone", () => {
    expect(autoScaleUvPerCount(40)).toBe(1);
    const scale = autoScaleUvPerCount(80_000);
    expect(80_000 * scale).toBeCloseTo(35, 1);
  });

  it("turns common Bluetooth failures into actionable bedside guidance", () => {
    expect(friendlyBleError(new DOMException("User cancelled", "NotFoundError"))).toContain(
      "No headband was selected",
    );
    expect(friendlyBleError(new Error("GATT Server is disconnected"))).toContain(
      "Unplug its charging cable",
    );
    expect(friendlyBleError(new Error("no stream decoded as EEG"))).toContain("no usable EEG signal");
    expect(
      friendlyBleError(new DOMException("Service is on the blocklist", "SecurityError")),
    ).toContain("browser rejected");
    expect(friendlyBleError(new Error("Operation already in progress"))).toContain("Bluefy");
  });
});
