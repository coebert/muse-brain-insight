import { describe, expect, it } from "vitest";

import { parseEdfHeader, pickEdfChannel, readEdfChannel } from "../edf";
import { chbAnnotations, chbSubject, chbSummaryUrl, parseChbRecording, parseChbSummary } from "../chbmit";
import { findSource, checkEligibility } from "../dataset-intake";

/** Build a tiny two-channel EDF in memory. */
function makeEdf(seconds: number, sampleRate: number, amplitudeUv: number): Uint8Array {
  const channels = ["FP1-F7", "F7-T7"];
  const ns = channels.length;
  const headerBytes = 256 * (ns + 1);
  const total = headerBytes + seconds * sampleRate * ns * 2;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const put = (at: number, width: number, value: string) => {
    const s = value.padEnd(width, " ").slice(0, width);
    for (let i = 0; i < width; i++) bytes[at + i] = s.charCodeAt(i);
  };
  put(0, 8, "0");
  put(184, 8, String(headerBytes));
  put(236, 8, String(seconds));
  put(244, 8, "1");
  put(252, 4, String(ns));
  channels.forEach((c, i) => put(256 + i * 16, 16, c));
  const block = (offsetUnits: number, i: number, width: number) => 256 + offsetUnits * ns + i * width;
  for (let i = 0; i < ns; i++) {
    put(block(96, i, 8), 8, "uV");
    put(block(104, i, 8), 8, "-3276.8");
    put(block(112, i, 8), 8, "3276.7");
    put(block(120, i, 8), 8, "-32768");
    put(block(128, i, 8), 8, "32767");
    put(block(216, i, 8), 8, String(sampleRate));
  }
  let p = headerBytes;
  for (let r = 0; r < seconds; r++) {
    for (let c = 0; c < ns; c++) {
      for (let s = 0; s < sampleRate; s++) {
        const t = r + s / sampleRate;
        const uv = (c === 0 ? amplitudeUv : 5) * Math.sin(2 * Math.PI * 10 * t);
        view.setInt16(p, Math.round(uv * 10), true);
        p += 2;
      }
    }
  }
  return bytes;
}

const SUMMARY = `Data Sampling Rate: 256 Hz

Channels in EDF Files:
Channel 1: FP1-F7

File Name: chb01_01.edf
File Start Time: 11:42:54
Number of Seizures in File: 0

File Name: chb01_03.edf
File Start Time: 13:43:04
Number of Seizures in File: 2
Seizure 1 Start Time: 10 seconds
Seizure 1 End Time: 20 seconds
Seizure 2 Start Time: 30 seconds
Seizure 2 End Time: 34 seconds
`;

describe("EDF reader", () => {
  it("reads the header and decodes the selected channel in microvolts", () => {
    const bytes = makeEdf(6, 64, 40);
    const header = parseEdfHeader(bytes);
    expect(header.channels).toEqual(["FP1-F7", "F7-T7"]);
    expect(header.numRecords).toBe(6);

    const decoded = readEdfChannel(bytes, ["FP1-F7"]);
    expect(decoded.channel).toBe("FP1-F7");
    expect(decoded.sampleRate).toBe(64);
    expect(decoded.signal).toHaveLength(6 * 64);
    expect(decoded.durationSeconds).toBe(6);
    const peak = Math.max(...decoded.signal);
    expect(peak).toBeGreaterThan(35);
    expect(peak).toBeLessThan(45);
  });

  it("matches channels ignoring case, spaces and an EEG prefix", () => {
    expect(pickEdfChannel(["EEG Fp1-F7", "ECG"], ["FP1-F7"])).toBe(0);
    expect(pickEdfChannel(["ECG", "EEG FP2-F8"], ["FP1-F7", "FP2-F8"])).toBe(1);
    expect(pickEdfChannel(["C3-P3", "EDF Annotations"], ["FP1-F7"])).toBe(0);
  });
});

describe("CHB-MIT summaries", () => {
  it("parses numbered seizure intervals per file", () => {
    const seizures = parseChbSummary(SUMMARY);
    expect(seizures).toHaveLength(2);
    expect(seizures[0]).toEqual({ file: "chb01_03.edf", startSeconds: 10, endSeconds: 20 });
    expect(chbAnnotations(seizures, "chb01/chb01_03.edf")).toHaveLength(2);
    expect(chbAnnotations(seizures, "chb01/chb01_01.edf")).toHaveLength(0);
  });

  it("derives the subject and its summary URL from a published path", () => {
    expect(chbSubject("chb01/chb01_03.edf")).toBe("chb01");
    expect(chbSummaryUrl("https://physionet.org/files/chbmit/1.0.0/chb05/chb05_02.edf")).toBe(
      "https://physionet.org/files/chbmit/1.0.0/chb05/chb05-summary.txt",
    );
  });

  it("labels epochs that overlap the published seizure interval", () => {
    const bytes = makeEdf(40, 64, 60);
    const parsed = parseChbRecording(bytes, {
      caseRef: "chb01_03",
      fileName: "chb01/chb01_03.edf",
      summary: parseChbSummary(SUMMARY),
    });
    expect(parsed.channel).toBe("FP1-F7");
    expect(parsed.epochs.length).toBeGreaterThan(5);
    const seizureEpochs = parsed.epochs.filter((e) => e.label === "seizure");
    expect(seizureEpochs.length).toBeGreaterThan(0);
    for (const e of seizureEpochs) expect(e.atSeconds).toBeGreaterThanOrEqual(8);
    expect(parsed.epochs.some((e) => e.atSeconds < 8 && e.label === "seizure")).toBe(false);
  });
});

describe("CHB-MIT intake source", () => {
  it("is registered as openly retrievable with its own lineage", () => {
    const source = findSource("physionet-chbmit")!;
    expect(source).toBeDefined();
    expect(source.lineage).toBe("external:physionet:chb-mit");
    expect(source.binary).toBe(true);
    expect(checkEligibility(source).eligible).toBe(true);
    expect(source.filePattern.test("chb01/chb01_03.edf")).toBe(true);
    expect(source.filePattern.test("chb01/chb01-summary.txt")).toBe(false);
  });
});
