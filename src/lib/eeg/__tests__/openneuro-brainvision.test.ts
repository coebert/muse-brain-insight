import { describe, expect, it } from "vitest";

import {
  brainVisionCaseRef,
  brainVisionRows,
  headerUrlFor,
  parseBrainVisionHeader,
  parseBrainVisionRecording,
  pickBrainVisionChannel,
  readBrainVisionChannel,
  sampleWidth,
  stateForTask,
  OPENNEURO_DS005620_LINEAGE,
} from "../openneuro-brainvision";

const HEADER = `Brain Vision Data Exchange Header File Version 1.0

[Common Infos]
DataFile=sub-1010_task-sed_eeg.eeg
MarkerFile=sub-1010_task-sed_eeg.vmrk
DataFormat=BINARY
DataOrientation=MULTIPLEXED
NumberOfChannels=3
; Sampling interval in microseconds
SamplingInterval=200.0

[Binary Infos]
BinaryFormat=IEEE_FLOAT_32

[Channel Infos]
Ch1=Iz,,0.1,µV
Ch2=AF3,,0.1,µV
Ch3=O2,,0.1,µV
`;

/** Three multiplexed float32 channels, `seconds` long at 5000 Hz. */
function binary(seconds: number): Uint8Array {
  const sr = 5000;
  const frames = seconds * sr;
  const buf = new ArrayBuffer(frames * 3 * 4);
  const view = new DataView(buf);
  for (let f = 0; f < frames; f++) {
    const t = f / sr;
    for (let c = 0; c < 3; c++) {
      // Channel 2 (AF3) carries a 10 Hz oscillation; the others are flat.
      const v = c === 1 ? Math.sin(2 * Math.PI * 10 * t) * 200 : 0;
      view.setFloat32((f * 3 + c) * 4, v, true);
    }
  }
  return new Uint8Array(buf);
}

describe("parseBrainVisionHeader", () => {
  it("reads sample rate, channels and storage format", () => {
    const h = parseBrainVisionHeader(HEADER);
    expect(h.sampleRate).toBe(5000);
    expect(h.channels.map((c) => c.label)).toEqual(["Iz", "AF3", "O2"]);
    expect(h.channels[0]!.resolutionUv).toBeCloseTo(0.1);
    expect(h.format).toBe("float32");
    expect(h.multiplexed).toBe(true);
    expect(h.dataFile).toBe("sub-1010_task-sed_eeg.eeg");
  });

  it("rejects ASCII recordings and headers without channels", () => {
    expect(() => parseBrainVisionHeader(HEADER.replace("BINARY", "ASCII"))).toThrow();
    expect(() => parseBrainVisionHeader("[Common Infos]\nSamplingInterval=200")).toThrow();
  });

  it("rejects a header with no sampling interval", () => {
    expect(() => parseBrainVisionHeader(HEADER.replace("SamplingInterval=200.0", ""))).toThrow();
  });

  it("maps each supported binary format to its width", () => {
    expect(sampleWidth("int16")).toBe(2);
    expect(sampleWidth("float32")).toBe(4);
  });
});

describe("readBrainVisionChannel", () => {
  it("decodes the frontal channel and applies the stored resolution", () => {
    const h = parseBrainVisionHeader(HEADER);
    const decoded = readBrainVisionChannel(binary(2), h);
    expect(decoded.channel).toBe("AF3");
    expect(decoded.sampleRate).toBe(5000);
    expect(decoded.durationSeconds).toBeCloseTo(2, 3);
    // 200 µV peak stored, scaled by the 0.1 resolution.
    expect(Math.max(...decoded.signal)).toBeCloseTo(20, 1);
  });

  it("prefers a frontal electrode, else falls back to the first channel", () => {
    const h = parseBrainVisionHeader(HEADER);
    expect(pickBrainVisionChannel(h.channels)).toBe(1);
    expect(pickBrainVisionChannel([{ label: "Cz", resolutionUv: 1 }])).toBe(0);
  });

  it("refuses a prefix too short to hold a second of signal", () => {
    const h = parseBrainVisionHeader(HEADER);
    expect(() => readBrainVisionChannel(binary(2).slice(0, 400), h)).toThrow();
  });
});

describe("labels and naming", () => {
  it("reads the depth state out of the BIDS task entity", () => {
    expect(stateForTask("awake")).toBe("awake");
    expect(stateForTask("sed")).toBe("sedated");
    expect(stateForTask("sed2")).toBe("sedated");
    expect(stateForTask("tms")).toBeNull();
    expect(stateForTask(null)).toBeNull();
  });

  it("keeps each recording condition as its own case", () => {
    expect(brainVisionCaseRef("sub-1010/eeg/sub-1010_task-sed2_acq-rest_run-1_eeg.eeg")).toBe(
      "sub-1010_task-sed2",
    );
  });

  it("points at the header beside the binary", () => {
    expect(headerUrlFor("https://x/sub-1_eeg.eeg?versionId=9")).toBe("https://x/sub-1_eeg.vhdr");
  });
});

describe("parseBrainVisionRecording", () => {
  it("labels every epoch with the published condition", () => {
    const h = parseBrainVisionHeader(HEADER);
    const parsed = parseBrainVisionRecording(binary(12), h, {
      caseRef: "sub-1010_task-sed",
      fileName: "sub-1010_task-sed_acq-rest_run-1_eeg.eeg",
    });
    expect(parsed.state).toBe("sedated");
    expect(parsed.epochs.length).toBeGreaterThan(1);
    expect(parsed.epochs.every((e) => e.label === "sedated")).toBe(true);
    expect(parsed.epochs.every((e) => e.labelSource === "dataset")).toBe(true);
    expect(parsed.epochs[0]!.externalRef).toContain("openneuro-ds005620:sub-1010_task-sed:AF3:");
  });

  it("stamps lineage and regimen onto stored rows", () => {
    const h = parseBrainVisionHeader(HEADER);
    const parsed = parseBrainVisionRecording(binary(8), h, {
      caseRef: "sub-1010_task-awake",
      fileName: "sub-1010_task-awake_acq-EC_eeg.eeg",
    });
    const rows = brainVisionRows(parsed.epochs, {
      datasetVersion: "1.0.0",
      fileName: "sub-1010_task-awake_acq-EC_eeg.eeg",
      channel: parsed.channel,
      state: parsed.state,
    });
    expect(rows[0]!.sourceLineage).toBe(OPENNEURO_DS005620_LINEAGE);
    expect(rows[0]!.covariates).toMatchObject({
      subject: "sub-1010",
      task: "awake",
      regimen: "propofol",
      published_state: "awake",
    });
  });
});
