import { describe, expect, it } from "vitest";

import { parseEdfHeader, parseTalBlock, readEdfAnnotations, readEdfChannel } from "../edf";
import { annotationsFromEdf } from "../corpus-upload";
import { UPLOAD_PRESETS } from "../corpus-upload";

/** Build a tiny EDF+ file: one 100 Hz EEG channel plus an annotation track. */
function buildEdfPlus(stages: string[]): Uint8Array {
  const ns = 2;
  const records = stages.length;
  const eegSpr = 100;
  const annSpr = 60; // bytes/2 per record for the annotation channel
  const headerBytes = 256 * (ns + 1);
  const recordBytes = (eegSpr + annSpr) * 2;
  const bytes = new Uint8Array(headerBytes + records * recordBytes);
  const put = (text: string, at: number, width: number) => {
    const padded = text.padEnd(width, " ").slice(0, width);
    for (let i = 0; i < width; i++) bytes[at + i] = padded.charCodeAt(i) & 0xff;
  };

  put("0", 0, 8);
  put("subject", 8, 80);
  put("recording", 88, 80);
  put("01.01.24", 168, 8);
  put("00.00.00", 176, 8);
  put(String(headerBytes), 184, 8);
  put("EDF+C", 192, 44);
  put(String(records), 236, 8);
  put("30", 244, 8); // 30 s records
  put(String(ns), 252, 4);

  const labels = ["EEG Fp1", "EDF Annotations"];
  const widths = [16, 80, 8, 8, 8, 8, 8, 80, 8, 32];
  const blockStart = (i: number) => 256 + widths.slice(0, i).reduce((a, w) => a + w * ns, 0);
  const field = (i: number, values: string[]) =>
    values.forEach((v, s) => put(v, blockStart(i) + s * widths[i]!, widths[i]!));
  field(0, labels);
  field(1, ["", ""]);
  field(2, ["uV", ""]);
  field(3, ["-100", "-1"]);
  field(4, ["100", "1"]);
  field(5, ["-32768", "-32768"]);
  field(6, ["32767", "32767"]);
  field(7, ["", ""]);
  field(8, [String(eegSpr), String(annSpr)]);

  const view = new DataView(bytes.buffer);
  stages.forEach((stage, r) => {
    const base = headerBytes + r * recordBytes;
    for (let s = 0; s < eegSpr; s++) {
      view.setInt16(base + s * 2, Math.round(3000 * Math.sin(s / 5)), true);
    }
    const onset = r * 30;
    const tal = `+${onset}\u0014\u0014\u0000+${onset}\u001530\u0014${stage}\u0014\u0000`;
    for (let i = 0; i < tal.length && i < annSpr * 2; i++) {
      bytes[base + eegSpr * 2 + i] = tal.charCodeAt(i) & 0xff;
    }
  });
  return bytes;
}

describe("EDF+ annotation track", () => {
  it("splits a TAL block into onset, duration and text", () => {
    const out = parseTalBlock("+0\u0014\u0014\u0000+30\u001530\u0014Sleep stage N2\u0014\u0000");
    expect(out).toEqual([{ onsetSeconds: 30, durationSeconds: 30, text: "Sleep stage N2" }]);
  });

  it("reads the stages a sleep record publishes inside the file", () => {
    const bytes = buildEdfPlus(["Sleep stage W", "Sleep stage N2", "Sleep stage R"]);
    const header = parseEdfHeader(bytes);
    expect(header.annotationChannels).toEqual([1]);
    expect(header.bytesPerSample).toBe(2);

    const annotations = readEdfAnnotations(bytes, header);
    expect(annotations.map((a) => a.text)).toEqual([
      "Sleep stage W",
      "Sleep stage N2",
      "Sleep stage R",
    ]);
  });

  it("skips the annotation track when picking a signal channel", () => {
    const decoded = readEdfChannel(buildEdfPlus(["Sleep stage W"]), ["AF7", "Fp1"]);
    expect(decoded.channel).toBe("EEG Fp1");
    expect(decoded.sampleRate).toBeCloseTo(100 / 30, 5);
  });

  it("normalises embedded stages into labelled intervals", () => {
    const preset = UPLOAD_PRESETS.find((p) => p.id === "openneuro-sleep")!;
    const read = annotationsFromEdf(buildEdfPlus(["Sleep stage W", "Sleep stage N3"]), preset.labelStyle);
    expect(read.annotations.map((a) => a.label)).toEqual(["awake", "sleep_n3"]);
    expect(read.annotations[1]).toMatchObject({ startSeconds: 30, stopSeconds: 60 });
  });
});
