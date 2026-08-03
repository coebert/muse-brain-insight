import { describe, expect, it } from "vitest";
import { decodeMusePacket } from "./muse";

/** Pack 12 twelve-bit samples after the 16-bit packet index, as the Muse does. */
function packet(samples: number[]): DataView {
  const bytes = new Uint8Array(20);
  let bitOffset = 16;
  for (const s of samples) {
    for (let b = 11; b >= 0; b--) {
      if ((s >> b) & 1) bytes[bitOffset >> 3]! |= 0x80 >> (bitOffset & 7);
      bitOffset++;
    }
  }
  return new DataView(bytes.buffer);
}

describe("decodeMusePacket", () => {
  it("returns 12 samples", () => {
    expect(decodeMusePacket(packet(new Array(12).fill(2048))).length).toBe(12);
  });

  it("maps the mid-scale code to 0 µV", () => {
    const out = decodeMusePacket(packet(new Array(12).fill(2048)));
    for (const v of out) expect(v).toBeCloseTo(0, 6);
  });

  it("applies the 0.48828125 µV/LSB scale symmetrically", () => {
    const out = decodeMusePacket(packet([4095, 0, 2148, 1948, ...new Array(8).fill(2048)]));
    expect(out[0]).toBeCloseTo(0.48828125 * 2047, 6);
    expect(out[1]).toBeCloseTo(-0.48828125 * 2048, 6);
    expect(out[2]).toBeCloseTo(0.48828125 * 100, 6);
    expect(out[3]).toBeCloseTo(-0.48828125 * 100, 6);
  });

  it("decodes each packed slot independently", () => {
    const codes = [2048, 2148, 2248, 2348, 2448, 2548, 2648, 2748, 2848, 2948, 3048, 3148];
    const out = decodeMusePacket(packet(codes));
    codes.forEach((c, i) => expect(out[i]).toBeCloseTo(0.48828125 * (c - 2048), 6));
  });
});
