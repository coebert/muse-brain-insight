import { describe, expect, it } from "vitest";

import {
  decodeZenLitePacket,
  ZenLiteDeframer,
  zenliteEegSamples,
  ZENLITE_UV_PER_COUNT,
} from "@/lib/eeg/brainco-zenlite";

/**
 * Byte-locked BrainCo AFE capture.
 *
 * One complete BRNC frame carrying the verified schema path (top-level field 2
 * -> AFE module field 2 -> AFE data field 4) with a sequence number, the 256 Hz
 * rate enum, and ten packed 24-bit big-endian samples spanning the full ADC
 * range. The hex below is the exact wire representation; if framing, CRC,
 * schema path, sample width, endianness or sign handling change, this fails.
 */
const CAPTURE_HEX =
  "42524e43010128001226122408071003221e0000000003e8fffc187fffff80000001e240f6040f00002affffd6001e611edd";

const EXPECTED_COUNTS = [0, 1000, -1000, 8388607, -8388608, 123456, -654321, 42, -42, 7777];

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));

describe("BrainCo captured-frame fixture", () => {
  it("decodes the captured frame to the exact sample sequence", () => {
    expect(decodeZenLitePacket(bytes(CAPTURE_HEX))).toEqual(EXPECTED_COUNTS);
  });

  it("decodes identically when the capture arrives split across notifications", () => {
    const frame = bytes(CAPTURE_HEX);
    const deframer = new ZenLiteDeframer();
    const out: number[] = [];
    for (let i = 0; i < frame.length; i += 7) {
      for (const payload of deframer.push(frame.subarray(i, i + 7))) {
        out.push(...zenliteEegSamples(payload));
      }
    }
    expect(out).toEqual(EXPECTED_COUNTS);
  });

  it("recovers after leading rubbish bytes without losing the frame", () => {
    const noisy = Uint8Array.from([0xaa, 0xbb, 0x42, 0x52, 0x00, ...bytes(CAPTURE_HEX)]);
    expect(decodeZenLitePacket(noisy)).toEqual(EXPECTED_COUNTS);
  });

  it("rejects the frame when a single payload byte is corrupted", () => {
    const corrupted = bytes(CAPTURE_HEX);
    corrupted[30] = (corrupted[30]! ^ 0xff) & 0xff;
    expect(decodeZenLitePacket(corrupted)).toEqual([]);
  });

  it("converts counts to microvolts with the vendor scale", () => {
    const uv = decodeZenLitePacket(bytes(CAPTURE_HEX)).map((c) => c * ZENLITE_UV_PER_COUNT);
    expect(uv[1]).toBeCloseTo(6.007, 3);
    expect(uv[2]).toBeCloseTo(-6.007, 3);
  });
});
