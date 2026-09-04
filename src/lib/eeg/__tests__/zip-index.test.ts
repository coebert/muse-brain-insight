import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";

import { readZipIndex, zipMemberByteRange, zipMemberPayload, zipMemberText } from "../zip-index";

/** Build a small two-member archive by hand so the reader is tested end to end. */
function buildZip(members: { name: string; body: string; deflate: boolean }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const m of members) {
    const raw = enc.encode(m.body);
    const payload = m.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = enc.encode(m.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, m.deflate ? 8 : 0, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, payload);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, m.deflate ? 8 : 0, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + payload.length;
  }

  const dirOffset = offset;
  const dirSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, members.length, true);
  ev.setUint16(10, members.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, dirOffset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

describe("ZIP central-directory reader", () => {
  const zip = buildZip([
    { name: "data/10-154.csv", body: "Time,EEG_1\n1,2\n", deflate: true },
    { name: "data/10-155.csv", body: "Time,EEG_1\n3,4\n", deflate: false },
  ]);

  it("lists members from the archive tail alone", () => {
    const tailStart = zip.length - 400 > 0 ? zip.length - 400 : 0;
    const members = readZipIndex(zip.subarray(tailStart), tailStart);
    expect(members.map((m) => m.name)).toEqual(["data/10-154.csv", "data/10-155.csv"]);
    expect(members[0]!.method).toBe(8);
    expect(members[1]!.method).toBe(0);
  });

  it("reads one member from its byte range without the rest of the archive", async () => {
    const members = readZipIndex(zip, 0);
    for (const member of members) {
      const { start, end } = zipMemberByteRange(member);
      const bytes = zip.subarray(start, Math.min(end, zip.length));
      expect(zipMemberPayload(member, bytes).length).toBe(member.compressedSize);
      await expect(zipMemberText(member, bytes)).resolves.toContain("Time,EEG_1");
    }
  });

  it("refuses an archive with no directory in the fetched tail", () => {
    expect(() => readZipIndex(zip.subarray(0, 10), 0)).toThrow(/end-of-directory/);
  });
});
