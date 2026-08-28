/// <reference types="web-bluetooth" />

/**
 * End-to-end cover for the BrainCo ZenLite band (Regul8 / FocusCalm / OxyZen):
 * the emulated firmware stays silent until it is paired and told to switch the
 * EEG front end on, which is the real-world failure this path exists to fix.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BleHeadsetSource } from "@/lib/eeg/ble-eeg";
import {
  zenliteFrame,
  ZENLITE_NOTIFY,
  ZENLITE_SERVICE,
  ZENLITE_WRITE,
} from "@/lib/eeg/brainco-zenlite";

const timers: ReturnType<typeof setInterval>[] = [];

afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
});

beforeAll(() => {
  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: { requestDevice: vi.fn() },
  });
});

/** Encodes one EEG data message the way the firmware reports it. */
function eegMessage(offset: number, count = 20): Uint8Array {
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = (offset + i) / 256;
    const value = Math.round(9_000 * Math.sin(2 * Math.PI * 10 * t));
    const raw = value < 0 ? value + 0x1000000 : value;
    data.push((raw >> 16) & 0xff, (raw >> 8) & 0xff, raw & 0xff);
  }
  const inner = [0x08, offset & 0x7f, 0x10, 0x03, 0x2a, data.length, ...data];
  return zenliteFrame([0x08, 0x2a, 0x4a, inner.length, ...inner]);
}

class ZenLiteNotify extends EventTarget {
  uuid = ZENLITE_NOTIFY;
  properties = { notify: true, indicate: false } as BluetoothCharacteristicProperties;
  value: DataView | undefined;
  streaming = false;
  private offset = 0;

  async startNotifications() {
    return this as unknown as BluetoothRemoteGATTCharacteristic;
  }

  async stopNotifications() {
    return this as unknown as BluetoothRemoteGATTCharacteristic;
  }

  /** Emits one message, fragmented across MTU-sized notifications. */
  emit() {
    if (!this.streaming) return;
    const frame = eegMessage(this.offset);
    this.offset += 20;
    for (let i = 0; i < frame.length; i += 20) {
      const chunk = frame.subarray(i, i + 20);
      this.value = new DataView(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
      this.dispatchEvent(new Event("characteristicvaluechanged"));
    }
  }
}

class ZenLiteWrite {
  uuid = ZENLITE_WRITE;
  properties = { write: true, writeWithoutResponse: false } as BluetoothCharacteristicProperties;
  frames: Uint8Array[] = [];

  constructor(private readonly notify: ZenLiteNotify) {}

  async writeValue(value: BufferSource) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.frames.push(bytes);
    // Field 3 (0x1a) carrying enum value 3 switches the AFE to 256 Hz.
    const afeStart = [0x1a, 0x02, 0x08, 0x03];
    const startsAfe = bytes.some(
      (_, index) => afeStart.every((byte, offset) => bytes[index + offset] === byte),
    );
    if (startsAfe) {
      this.notify.streaming = true;
      // Real firmware streams continuously once started, so keep emitting for
      // the whole discovery window rather than in one burst.
      timers.push(setInterval(() => this.notify.emit(), 20));
    }
  }
}

function zenliteDevice() {
  const notify = new ZenLiteNotify();
  const write = new ZenLiteWrite(notify);
  const service = {
    uuid: ZENLITE_SERVICE,
    async getCharacteristics() {
      return [
        notify as unknown as BluetoothRemoteGATTCharacteristic,
        write as unknown as BluetoothRemoteGATTCharacteristic,
      ];
    },
    async getCharacteristic(uuid: string) {
      if (uuid === ZENLITE_WRITE) return write as unknown as BluetoothRemoteGATTCharacteristic;
      throw new DOMException("Not found", "NotFoundError");
    },
  } as unknown as BluetoothRemoteGATTService;
  const server = {
    connected: false,
    async connect() {
      this.connected = true;
      return this;
    },
    disconnect() {
      this.connected = false;
    },
    async getPrimaryServices() {
      return [service];
    },
    async getPrimaryService() {
      throw new DOMException("Not found", "NotFoundError");
    },
  };
  const device = new EventTarget() as BluetoothDevice;
  Object.defineProperties(device, {
    name: { value: "Regul8" },
    id: { value: "zenlite-test" },
    gatt: { value: server },
  });
  return { device, server, notify, write };
}

describe("BrainCo ZenLite headband", () => {
  it("pairs, starts the stream and ingests 256 Hz EEG", async () => {
    const { device, server, notify, write } = zenliteDevice();
    const samples: number[] = [];
    const source = new BleHeadsetSource({ device, listenSeconds: 1 });

    await source.start((_channel, chunk) => samples.push(...chunk));
    // Let the live stream run past discovery so mapped samples reach the sink.
    await new Promise((r) => setTimeout(r, 600));

    // pair, re-validate, then AFE start.
    expect(write.frames.length).toBe(3);
    expect(notify.streaming).toBe(true);
    expect(source.discovery?.format).toBe("brainco-zenlite");
    expect(source.discovery?.serviceUuid).toBe(ZENLITE_SERVICE);
    expect(source.discovery?.characteristicUuid).toBe(ZENLITE_NOTIFY);
    expect(source.discovery?.sampleRate).toBe(256);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(Number.isFinite)).toBe(true);

    await source.stop();
    expect(server.connected).toBe(false);
  }, 20_000);

  it("never leaves a band silent because the start command was skipped", async () => {
    const { device, write } = zenliteDevice();
    const source = new BleHeadsetSource({ device, listenSeconds: 1 });
    await source.start(() => {});
    const afe = write.frames.find((frame) =>
      frame.some(
        (_, index) => [0x1a, 0x02, 0x08, 0x03].every((byte, offset) => frame[index + offset] === byte),
      ),
    );
    expect(afe).toBeDefined();
    // 0x1a submessage carrying sample-rate enum 3 (256 Hz).
    expect(
      afe?.some(
        (_, index) => [0x1a, 0x02, 0x08, 0x03].every((byte, offset) => afe[index + offset] === byte),
      ),
    ).toBe(true);
    await source.stop();
  }, 20_000);
});
