import { describe, expect, it } from "vitest";

import {
  zenliteAfeInfo,
  zenliteFrame,
  zenliteSampleRateFromEnum,
  zenliteStreamInfo,
  ZENLITE_AFE,
} from "@/lib/eeg/brainco-zenlite";

function varint(value: number): number[] {
  const out: number[] = [];
  let n = value;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

const delimited = (field: number, body: number[]) => [
  (field << 3) | 2,
  ...varint(body.length),
  ...body,
];

/** One AFE frame with a sequence number, a rate enum and `count` samples. */
function afeFrame(sequence: number, rateEnum: number, count: number): Uint8Array {
  const packed: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = ((i * 137) % 4096) - 2048;
    const u = v < 0 ? v + 0x1000000 : v;
    packed.push((u >> 16) & 0xff, (u >> 8) & 0xff, u & 0xff);
  }
  const afeData = [
    (1 << 3) | 0,
    ...varint(sequence),
    (2 << 3) | 0,
    ...varint(rateEnum),
    ...delimited(4, packed),
  ];
  return zenliteFrame(delimited(2, delimited(2, afeData)));
}

describe("ZenLite AFE header", () => {
  it("reads the sequence number, rate enum and sample count", () => {
    const frames = zenliteStreamInfo(afeFrame(11, ZENLITE_AFE.sr256, 20));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      sequence: 11,
      sampleRateEnum: ZENLITE_AFE.sr256,
      sampleRateHz: 256,
      sampleCount: 20,
    });
  });

  it("resolves the alternative documented rate", () => {
    const [info] = zenliteStreamInfo(afeFrame(1, ZENLITE_AFE.sr128, 6));
    expect(info?.sampleRateHz).toBe(128);
  });

  it("reports an unknown enum as unresolved rather than guessing", () => {
    const [info] = zenliteStreamInfo(afeFrame(1, 99, 6));
    expect(info?.sampleRateEnum).toBe(99);
    expect(info?.sampleRateHz).toBeNull();
    expect(zenliteSampleRateFromEnum(99)).toBeNull();
  });

  it("reads every frame in a multi-frame notification", () => {
    const a = afeFrame(1, ZENLITE_AFE.sr256, 9);
    const b = afeFrame(2, ZENLITE_AFE.sr256, 9);
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    expect(zenliteStreamInfo(joined).map((f) => f.sequence)).toEqual([1, 2]);
  });

  it("returns null for a payload that is not an AFE message", () => {
    expect(zenliteAfeInfo(Uint8Array.from([0x08, 0x01]))).toBeNull();
  });
});
