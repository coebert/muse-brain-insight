/// <reference types="web-bluetooth" />

/**
 * End-to-end cover for the one-tap activation check against a simulated
 * FC-11/Regul8 band: the check must send the documented pairing, front-end and
 * START commands, notice notifications starting inside the deadline, and name
 * the sequence that worked. A band that stays silent must fail the check with
 * a usable reason rather than appearing to pass.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { activationCheckJson, runActivationCheck } from "@/lib/eeg/ble-activation-check";
import {
  ZENLITE_CMD,
  ZENLITE_NOTIFY_FC11,
  ZENLITE_SERVICE_FC11,
  ZENLITE_WRITE_FC11,
  zenliteFrame,
} from "@/lib/eeg/brainco-zenlite";

beforeAll(() => {
  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: { requestDevice: vi.fn() },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Minimal protobuf helpers, matching the encoder used by the driver. */
const varint = (value: number): number[] => {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
};
const varintField = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
const bytesField = (field: number, body: number[]) => [
  ...varint((field << 3) | 2),
  ...varint(body.length),
  ...body,
];

/** A firmware system acknowledgement (`SysModule.Resp`). */
function sysAck(command: number, result: number): Uint8Array {
  return zenliteFrame([
    ...varintField(1, 1),
    ...bytesField(5, [...varintField(1, command), ...varintField(2, result)]),
  ]);
}

/** A 24-bit signed big-endian EEG data frame. */
function eegFrame(offset: number): Uint8Array {
  const samples: number[] = [];
  for (let i = 0; i < 16; i++) {
    const value = Math.round(120_000 * Math.sin((2 * Math.PI * 10 * (offset + i)) / 256));
    const u = value < 0 ? value + 0x1000000 : value;
    samples.push((u >> 16) & 0xff, (u >> 8) & 0xff, u & 0xff);
  }
  return zenliteFrame([...varintField(1, 2), ...bytesField(2, bytesField(2, bytesField(4, samples)))]);
}

interface BandOptions {
  /** Commands the band answers with an error instead of success. */
  rejectPairing?: boolean;
  /** When false the band never streams, however it is asked. */
  streams?: boolean;
}

/** A simulated BrainCo FC-11 band that only streams after PAIR → AFE → START. */
class MockBand {
  paired = false;
  afeOn = false;
  streaming = false;
  writes: Uint8Array[] = [];
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly notify = new MockNotifyCharacteristic();
  readonly write: BluetoothRemoteGATTCharacteristic;

  constructor(private options: BandOptions = {}) {
    const band = this;
    this.write = {
      uuid: ZENLITE_WRITE_FC11,
      properties: { write: true, writeWithoutResponse: true } as BluetoothCharacteristicProperties,
      async writeValueWithResponse(value: BufferSource) {
        band.handleWrite(value);
      },
      async writeValueWithoutResponse(value: BufferSource) {
        band.handleWrite(value);
      },
      async writeValue(value: BufferSource) {
        band.handleWrite(value);
      },
    } as unknown as BluetoothRemoteGATTCharacteristic;
  }

  private handleWrite(value: BufferSource) {
    const bytes = new Uint8Array(
      value instanceof ArrayBuffer ? value : (value as ArrayBufferView).buffer,
    );
    this.writes.push(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

    // The command id is the only field the simulator needs to react to.
    if (hex.includes("0801") && hex.includes("3210")) {
      // pair, 16-byte identity
      if (this.options.rejectPairing) {
        this.notify.emit(sysAck(ZENLITE_CMD.pair, 4));
        return;
      }
      this.paired = true;
      this.notify.emit(sysAck(ZENLITE_CMD.pair, 0));
      return;
    }
    if (hex.includes("1a02")) {
      // AFE configuration
      this.afeOn = this.paired;
      this.notify.emit(sysAck(ZENLITE_CMD.getSystemMonitor, this.paired ? 0 : 1));
      return;
    }
    if (hex.includes("12020803")) {
      // system START
      this.notify.emit(sysAck(ZENLITE_CMD.startDataStream, this.paired && this.afeOn ? 0 : 1));
      if (this.paired && this.afeOn && this.options.streams !== false) this.startStream();
    }
  }

  private startStream() {
    if (this.streaming) return;
    this.streaming = true;
    this.timer = setInterval(() => {
      this.notify.emit(eegFrame(this.offset));
      this.offset += 16;
    }, 50);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  device(): BluetoothDevice {
    const band = this;
    const service = {
      uuid: ZENLITE_SERVICE_FC11,
      async getCharacteristics() {
        return [band.notify as unknown as BluetoothRemoteGATTCharacteristic, band.write];
      },
    } as BluetoothRemoteGATTService;
    const server = {
      connected: false,
      async connect() {
        this.connected = true;
        return this;
      },
      disconnect() {
        this.connected = false;
        band.stop();
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
      id: { value: "f8fcbc0a-3d75-47aa-9c11-0000000000aa" },
      gatt: { value: server },
    });
    return device;
  }
}

class MockNotifyCharacteristic extends EventTarget {
  uuid = ZENLITE_NOTIFY_FC11;
  properties = { notify: true, indicate: false } as BluetoothCharacteristicProperties;
  value: DataView | undefined;
  subscribed = false;

  async startNotifications() {
    this.subscribed = true;
    return this as unknown as BluetoothRemoteGATTCharacteristic;
  }

  async stopNotifications() {
    this.subscribed = false;
    return this as unknown as BluetoothRemoteGATTCharacteristic;
  }

  emit(frame: Uint8Array) {
    if (!this.subscribed) return;
    const copy = new Uint8Array(frame);
    this.value = new DataView(copy.buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

/** Drives fake timers until the run resolves, so a 60s check runs instantly. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const settled = promise.finally(() => {
    done = true;
  });
  while (!done) {
    await vi.advanceTimersByTimeAsync(500);
  }
  return settled;
}

describe("one-tap activation check", () => {
  it("activates a silent band and reports the sequence that started the stream", async () => {
    vi.useFakeTimers();
    const band = new MockBand();

    const result = await drive(
      runActivationCheck({ device: band.device(), deadlineSeconds: 60 }),
    );
    band.stop();

    expect(band.paired).toBe(true);
    expect(band.afeOn).toBe(true);
    expect(band.streaming).toBe(true);
    expect(result.outcome).toBe("streaming-eeg");
    expect(result.passed).toBe(true);
    expect(result.timeToFirstPacketSeconds).not.toBeNull();
    expect(result.timeToFirstPacketSeconds!).toBeLessThanOrEqual(60);
    expect(result.activatedByVariant).toBe("Pair → AFE → START");
    expect(result.report.acks.length).toBeGreaterThan(0);
  }, 30_000);

  it("fails with the firmware's own error code when pairing is rejected", async () => {
    vi.useFakeTimers();
    const band = new MockBand({ rejectPairing: true });

    const result = await drive(
      runActivationCheck({ device: band.device(), deadlineSeconds: 30 }),
    );
    band.stop();

    expect(band.streaming).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.outcome).toBe("rejected");
    expect(result.errors.some((ack) => ack.sysResult === "INVALID_PAIR_INFO_ERR")).toBe(true);
    expect(result.advice).toMatch(/pairing/i);
  }, 30_000);

  it("reports a completely silent band rather than claiming success", async () => {
    vi.useFakeTimers();
    const band = new MockBand();
    band.notify.emit = () => {};

    const result = await drive(
      runActivationCheck({ device: band.device(), deadlineSeconds: 20 }),
    );
    band.stop();

    expect(result.passed).toBe(false);
    expect(result.outcome).toBe("silent");
    expect(result.timeToFirstPacketSeconds).toBeNull();
    expect(result.summary).toMatch(/No notifications/i);
  }, 30_000);
});

describe("activation check export", () => {
  it("serialises the sequences, every code with timestamps and the timing", async () => {
    vi.useFakeTimers();
    const band = new MockBand();
    const result = await drive(runActivationCheck({ device: band.device(), deadlineSeconds: 60 }));
    band.stop();

    const parsed = JSON.parse(activationCheckJson(result));

    expect(parsed.kind).toBe("activation-check");
    expect(parsed.verdict.passed).toBe(true);
    expect(parsed.verdict.timeToFirstPacketSeconds).toBeGreaterThanOrEqual(0);
    expect(parsed.verdict.activatedByVariant).toBe("Pair → AFE → START");
    expect(parsed.sequences.length).toBeGreaterThan(0);
    expect(parsed.sequences[0].sentHex).toMatch(/^[0-9a-f ]+$/);
    expect(parsed.acks.length).toBeGreaterThan(0);
    expect(parsed.loggedAcks.length).toBeGreaterThan(0);
    expect(parsed.loggedAcks[0].iso).toMatch(/T/);
    expect(parsed.loggedAcks[0]).toHaveProperty("variant");
    expect(parsed.captureContext.deviceName).toBe("Regul8");
  }, 30_000);
});
