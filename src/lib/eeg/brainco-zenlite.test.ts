import { describe, expect, it } from "vitest";

import {
  crc16Modbus,
  decodeZenLitePacket,
  zenliteAfeCommand,
  ZenLiteDeframer,
  zenliteEegSamples,
  zenliteFrame,
  zenliteFrameWith,
  zenliteSysPayload,
  ZENLITE_FRAMING_VARIANTS,
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
    expect(hex(zenliteSysCommand(4, ZENLITE_CMD.startDataStream))).toBe(
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

describe("verified vendor wire format", () => {
  const hexOf = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

  it("matches vendor packer bytes for pair, validate, AFE and start-stream", () => {
    // Reference bytes produced by BrainCo's own command packers.
    expect(hexOf(zenlitePairCommand(1, true, "0123456789abcdef"))).toBe(
      "42524e4301011800080112140801321030313233343536373839616263646566dd3a",
    );
    expect(hexOf(zenlitePairCommand(2, false, "0123456789abcdef"))).toBe(
      "42524e4301011800080212140802321030313233343536373839616263646566cd9b",
    );
    expect(hexOf(zenliteSysCommand(3, ZENLITE_CMD.startDataStream))).toBe(
      "42524e4301010600080312020803e672",
    );
    expect(hexOf(zenliteAfeCommand(6, ZENLITE_AFE.sr256))).toBe(
      "42524e430101060008061a0208032812",
    );
  });

  it("decodes EEG samples from the verified AFE data path", () => {
    const varint = (n: number) => {
      const out: number[] = [];
      let v = n;
      do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v) b |= 0x80;
        out.push(b);
      } while (v);
      return out;
    };
    const bytesField = (f: number, body: number[]) => [
      ...varint((f << 3) | 2),
      ...varint(body.length),
      ...body,
    ];
    const varintField = (f: number, v: number) => [...varint((f << 3) | 0), ...varint(v)];
    const samples = [0x00, 0x00, 0x01, 0xff, 0xff, 0xff, 0x00, 0x10, 0x00];
    const afeData = [...varintField(1, 7), ...varintField(2, ZENLITE_AFE.sr256), ...bytesField(4, samples)];
    const frame = zenliteFrame([...varintField(1, 7), ...bytesField(2, bytesField(2, afeData))]);
    expect(decodeZenLitePacket(frame)).toEqual([1, -1, 4096]);
  });
});

describe("framing variants", () => {
  const hexOf = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  const payload = zenliteSysPayload(4, ZENLITE_CMD.startDataStream);

  it("reproduces the documented frame with the default variant", () => {
    expect(hexOf(zenliteFrameWith(payload, ZENLITE_FRAMING_VARIANTS[0]!))).toBe(
      hexOf(zenliteSysCommand(4, ZENLITE_CMD.startDataStream)),
    );
  });

  it("swaps length and checksum byte order for the big-endian variant", () => {
    const le = zenliteFrameWith(payload, { label: "le", checksum: "modbus", endian: "le" });
    const be = zenliteFrameWith(payload, { label: "be", checksum: "modbus", endian: "be" });
    expect(be[6]).toBe(le[7]);
    expect(be[7]).toBe(le[6]);
    const crc = crc16Modbus(be.subarray(0, be.length - 2));
    expect(be[be.length - 2]).toBe(crc >> 8);
    expect(be[be.length - 1]).toBe(crc & 0xff);
  });

  it("omits the checksum entirely when asked", () => {
    const bare = zenliteFrameWith(payload, { label: "none", checksum: "none", endian: "le" });
    expect(bare.length).toBe(payload.length + 8);
  });
});
