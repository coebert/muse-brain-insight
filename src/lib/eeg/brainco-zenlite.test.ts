import { describe, expect, it } from "vitest";

import {
  crc16Modbus,
  decodeZenLitePacket,
  zenliteAfeCommand,
  ZenLiteDeframer,
  zenliteEegSamples,
  zenliteFrame,
  zenlitePairCommand,
  zenliteSysCommand,
  ZENLITE_AFE,
  ZENLITE_CMD,
} from "@/lib/eeg/brainco-zenlite";

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Reference frames produced by BrainCo's published OxyZen SDK build. These pin
 * the wire format: if a refactor changes a byte, the headband stops streaming.
 */
describe("ZenLite command encoding", () => {
  const uuid = "0123456789abcdef";

  it("encodes the pair command exactly as the vendor SDK does", () => {
    expect(hex(zenlitePairCommand(1, true, uuid))).toBe(
      "42524e4301011800080112140801321030313233343536373839616263646566dd3a",
    );
  });

  it("encodes re-validation of an existing pairing", () => {
    expect(hex(zenlitePairCommand(2, false, uuid))).toBe(
      "42524e4301011800080212140802321030313233343536373839616263646566cd9b",
    );
  });

  it("encodes the 256 Hz EEG start command", () => {
    expect(hex(zenliteAfeCommand(3, ZENLITE_AFE.sr256))).toBe(
      "42524e430101060008031a020803e412",
    );
  });

  it("encodes a system command", () => {
    expect(hex(zenliteSysCommand(4, ZENLITE_CMD.getSystemInfo))).toBe(
      "42524e430101060008041202080353b2",
    );
  });

  it("pads or truncates the pairing identity to 16 bytes", () => {
    expect(zenlitePairCommand(1, true, "short").length).toBe(
      zenlitePairCommand(1, true, uuid).length,
    );
    expect(zenlitePairCommand(1, true, `${uuid}extra`).length).toBe(
      zenlitePairCommand(1, true, uuid).length,
    );
  });

  it("uses CRC-16/MODBUS over header and payload", () => {
    const frame = zenliteFrame([0x08, 0x01]);
    const crc = crc16Modbus(frame.subarray(0, frame.length - 2));
    expect(frame[frame.length - 2]).toBe(crc & 0xff);
    expect(frame[frame.length - 1]).toBe(crc >> 8);
  });
});

/** Builds a device -> host EEG message: msg_id, then an EEG submessage. */
function eegFrame(samples: number[], field = 9): Uint8Array {
  const data: number[] = [];
  for (const s of samples) {
    const raw = s < 0 ? s + 0x1000000 : s;
    data.push((raw >> 16) & 0xff, (raw >> 8) & 0xff, raw & 0xff);
  }
  const inner = [0x08, 0x07, 0x10, 0x03, (field << 3) | 2, data.length, ...data];
  return zenliteFrame([0x08, 0x2a, (field << 3) | 2, inner.length, ...inner]);
}

describe("ZenLite data decoding", () => {
  const samples = Array.from({ length: 20 }, (_, i) => (i % 2 ? -1 : 1) * (1000 + i * 37));

  it("recovers 24-bit signed samples from a data frame", () => {
    expect(decodeZenLitePacket(eegFrame(samples))).toEqual(samples);
  });

  it("reassembles frames split across BLE notifications", () => {
    const frame = eegFrame(samples);
    const deframer = new ZenLiteDeframer();
    const out: number[] = [];
    for (let i = 0; i < frame.length; i += 17) {
      for (const payload of deframer.push(frame.subarray(i, i + 17))) {
        out.push(...zenliteEegSamples(payload));
      }
    }
    expect(out).toEqual(samples);
  });

  it("accepts firmware transport-version changes while preserving CRC validation", () => {
    const frame = eegFrame(samples);
    frame[4] = 2;
    frame[5] = 7;
    const crc = crc16Modbus(frame.subarray(0, frame.length - 2));
    frame[frame.length - 2] = crc & 0xff;
    frame[frame.length - 1] = crc >> 8;
    expect(decodeZenLitePacket(frame)).toEqual(samples);
  });

  it("rejects frames with a corrupted checksum", () => {
    const frame = eegFrame(samples);
    frame[frame.length - 1] = (frame[frame.length - 1]! ^ 0xff) & 0xff;
    expect(decodeZenLitePacket(frame)).toEqual([]);
  });

  it("resynchronises after leading rubbish and decodes back-to-back frames", () => {
    const a = eegFrame(samples);
    const b = eegFrame(samples.map((s) => -s));
    const stream = Uint8Array.from([0x01, 0x02, 0x03, ...a, ...b]);
    expect(decodeZenLitePacket(stream)).toEqual([...samples, ...samples.map((s) => -s)]);
  });

  it("ignores short non-EEG blocks such as IMU payloads", () => {
    const imu = zenliteFrame([0x08, 0x05, 0x2a, 0x06, 1, 2, 3, 4, 5, 6]);
    expect(decodeZenLitePacket(imu)).toEqual([]);
  });
});
