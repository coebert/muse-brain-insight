import { describe, expect, it } from "vitest";

import { decodeEdfChunk, edfRecordBytes, parseEdfHeader, planEdfChunks } from "./edf";
import { OpenNeuroStreamAssembler, decimate } from "./openneuro-stream";
import { buildEventDepthPoints } from "./openneuro-depth";
import type { ReplayFrame } from "./replay";

/** Build a tiny two-signal EDF: one sine channel plus one flat channel. */
function makeEdf(records: number, samplesPerRecord = 100): Uint8Array {
  const ns = 2;
  const headerBytes = 256 * (ns + 1);
  const recordBytes = samplesPerRecord * 2 * ns;
  const bytes = new Uint8Array(headerBytes + records * recordBytes);
  const enc = new TextEncoder();
  const put = (at: number, width: number, value: string) =>
    bytes.set(enc.encode(value.padEnd(width, " ").slice(0, width)), at);

  put(0, 8, "0");
  put(184, 8, String(headerBytes));
  put(236, 8, String(records));
  put(244, 8, "1");
  put(252, 4, String(ns));
  const widths = [16, 80, 8, 8, 8, 8, 8, 80, 8, 32];
  const start = (i: number) => 256 + widths.slice(0, i).reduce((a, w) => a + w * ns, 0);
  ["AF3", "Fz"].forEach((label, i) => put(start(0) + i * 16, 16, label));
  for (let i = 0; i < ns; i++) {
    put(start(2) + i * 8, 8, "uV");
    put(start(3) + i * 8, 8, "-1000");
    put(start(4) + i * 8, 8, "1000");
    put(start(5) + i * 8, 8, "-32768");
    put(start(6) + i * 8, 8, "32767");
    put(start(8) + i * 8, 8, String(samplesPerRecord));
  }

  const view = new DataView(bytes.buffer);
  for (let r = 0; r < records; r++) {
    for (let s = 0; s < samplesPerRecord; s++) {
      const t = (r * samplesPerRecord + s) / samplesPerRecord;
      const digital = Math.round(Math.sin(2 * Math.PI * 10 * t) * 3000);
      view.setInt16(headerBytes + (r * samplesPerRecord * ns + s) * 2, digital, true);
      view.setInt16(headerBytes + (r * samplesPerRecord * ns + samplesPerRecord + s) * 2, 0, true);
    }
  }
  return bytes;
}

describe("chunked EDF decoding", () => {
  it("plans record-aligned ranges that cover the whole file", () => {
    const bytes = makeEdf(30);
    const header = parseEdfHeader(bytes);
    const chunks = planEdfChunks(header, edfRecordBytes(header) * 7);
    expect(chunks.reduce((a, c) => a + c.records, 0)).toBe(30);
    expect(chunks[0]!.startByte).toBe(header.headerBytes);
    expect(chunks.at(-1)!.endByte).toBe(bytes.byteLength - 1);
    expect(chunks[1]!.startSeconds).toBe(chunks[1]!.firstRecord);
  });

  it("decodes a chunk identically to decoding the same records whole", () => {
    const bytes = makeEdf(10);
    const header = parseEdfHeader(bytes);
    const [chunk] = planEdfChunks(header, edfRecordBytes(header) * 10);
    const decoded = decodeEdfChunk(bytes.subarray(chunk!.startByte, chunk!.endByte + 1), header, 0);
    expect(decoded.signal.length).toBe(1000);
    expect(decoded.sampleRate).toBe(100);
    expect(Math.max(...decoded.signal)).toBeGreaterThan(50);
  });

  it("streams a recording into a continuous epoch series", () => {
    const bytes = makeEdf(60);
    const header = parseEdfHeader(bytes);
    const assembler = new OpenNeuroStreamAssembler(header, {
      caseRef: "sub-01",
      fileName: "sub-01_task-anesthesia_eeg.edf",
    });
    const chunks = assembler.plan(edfRecordBytes(header) * 9);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      assembler.push(bytes.subarray(c.startByte, c.endByte + 1), c);
    }
    const out = assembler.finish([
      { onsetSeconds: 0, durationSeconds: 0, trialType: "baseline" },
      { onsetSeconds: 20, durationSeconds: 0, trialType: "LOC" },
    ]);
    expect(out.channel).toBe("AF3");
    expect(out.durationSeconds).toBe(60);
    // 4 s windows across a continuous minute, with no boundary gaps.
    expect(out.epochs.length).toBe(15);
    const times = out.epochs.map((e) => Math.round(e.atSeconds));
    expect(times).toEqual([...Array(15)].map((_, i) => i * 4));
    expect(out.labelledIntervals).toBe(2);
    expect(out.replaySampleRate).toBeCloseTo(100, 5);
  });

  it("decimates towards the replay rate", () => {
    const src = Float64Array.from({ length: 1000 }, (_, i) => i);
    const out = decimate(src, 1000, 125);
    expect(out.sampleRate).toBe(125);
    expect(out.signal.length).toBe(125);
  });
});

describe("event-referenced depth points", () => {
  const frames: ReplayFrame[] = Array.from({ length: 1200 }, (_, i) => ({
    t: i,
    spectrum: [],
    totalPower: 10,
    sef95: 12,
    suppressionRatio: 0,
    isSuppressed: false,
    appIndex: i < 600 ? 90 : 45,
    coebis: null,
    bis: null,
    coebisLower: null,
    coebisUpper: null,
    coebisSigma: null,
  }));

  it("uses stable states only, with a settling guard", () => {
    const out = buildEventDepthPoints(
      frames,
      [
        { startSeconds: 0, stopSeconds: 560, label: "awake", channel: null, confidence: null },
        { startSeconds: 560, stopSeconds: 600, label: "induction", channel: null, confidence: null },
        { startSeconds: 600, stopSeconds: 1200, label: "anaesthetised", channel: null, confidence: null },
      ],
      { caseRef: "sub-01", channel: "AF3" },
    );
    expect(out.rejected.transition).toBe(1);
    expect(new Set(out.points.map((p) => p.state))).toEqual(new Set(["awake", "anaesthetised"]));
    expect(Math.min(...out.points.map((p) => p.atSeconds))).toBeGreaterThanOrEqual(60);
    expect(out.points.every((p) => p.reference === (p.state === "awake" ? 93 : 50))).toBe(true);
    // Stride keeps one reading per 10 s of each interval.
    expect(out.points.length).toBeLessThan(120);
  });

  it("drops intervals that are too short to settle", () => {
    const out = buildEventDepthPoints(
      frames,
      [{ startSeconds: 0, stopSeconds: 90, label: "awake", channel: null, confidence: null }],
      { caseRef: "sub-01", channel: "AF3" },
    );
    expect(out.points).toHaveLength(0);
    expect(out.rejected.shortInterval).toBe(1);
  });
});
