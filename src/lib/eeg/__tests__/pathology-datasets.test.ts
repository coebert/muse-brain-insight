import { describe, expect, it } from "vitest";

import {
  PATHOLOGY_DATASETS,
  applyAnnotations,
  epochsFromPathologyRecording,
  isSeizureLabel,
  normalisePathologyLabel,
  parsePathologyAnnotations,
  pathologyDataset,
  summarisePathologyLabels,
  toPathologyRows,
} from "../pathology-datasets";
import type { PhysionetEpoch } from "../physionet";

const epoch = (atSeconds: number): PhysionetEpoch => ({
  caseRef: "case-1",
  channel: "FP1",
  atSeconds,
  epochSeconds: 4,
  sampleRate: 250,
  spectrumDb: [],
  bands: { delta: 1, theta: 1, alpha: 1, beta: 1, gamma: 1 },
  totalPower: 5,
  sef95: 12,
  suppressionRatio: 0,
  isSuppressed: false,
  label: null,
  labelSource: "derived",
  externalRef: `ref-${atSeconds}`,
});

describe("dataset registry", () => {
  it("gives every collection a distinct lineage and a licence", () => {
    const lineages = new Set(PATHOLOGY_DATASETS.map((d) => d.lineage));
    expect(lineages.size).toBe(PATHOLOGY_DATASETS.length);
    expect(PATHOLOGY_DATASETS.every((d) => d.licence.length > 0)).toBe(true);
    expect(PATHOLOGY_DATASETS.some((d) => d.category === "cns-disease")).toBe(true);
  });

  it("rejects an unknown collection rather than guessing", () => {
    expect(() => pathologyDataset("nope" as never)).toThrow(/Unknown/);
  });
});

describe("normalisePathologyLabel", () => {
  it("maps TUSZ codes onto readable names", () => {
    expect(normalisePathologyLabel("fnsz")).toBe("focal_seizure");
    expect(normalisePathologyLabel("GNSZ")).toBe("generalised_seizure");
    expect(normalisePathologyLabel("cpsz")).toBe("focal_impaired_awareness_seizure");
    expect(normalisePathologyLabel("bckg")).toBe("background");
  });

  it("maps plain English and clinical verdicts onto the same set", () => {
    expect(normalisePathologyLabel("Seizure")).toBe("seizure");
    expect(normalisePathologyLabel("tonic-clonic")).toBe("tonic_clonic_seizure");
    expect(normalisePathologyLabel("abnormal")).toBe("abnormal");
    expect(normalisePathologyLabel("PLED")).toBe("lateralised_periodic_discharges");
    expect(normalisePathologyLabel("  ")).toBeNull();
  });

  it("only counts real seizures as seizures", () => {
    expect(isSeizureLabel("focal_seizure")).toBe(true);
    expect(isSeizureLabel("epileptiform_discharge")).toBe(false);
    expect(isSeizureLabel("background")).toBe(false);
    expect(isSeizureLabel(null)).toBe(false);
  });
});

describe("parsePathologyAnnotations", () => {
  it("reads the TUSZ csv_bi shape past its comment preamble", () => {
    const events = parsePathologyAnnotations(
      "# version = csv_v1.0.0\n# duration = 300 secs\nchannel,start_time,stop_time,label,confidence\nTERM,12.0,40.5,fnsz,1.0\nTERM,40.5,300.0,bckg,1.0\n",
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ startSeconds: 12, stopSeconds: 40.5, label: "focal_seizure" });
    expect(events[0]!.channel).toBe("TERM");
    expect(events[0]!.confidence).toBe(1);
  });

  it("reads a bare start/stop summary and sorts it", () => {
    const events = parsePathologyAnnotations("start,end,event\n90,110,seizure\n10,20,seizure\n");
    expect(events.map((e) => e.startSeconds)).toEqual([10, 90]);
    expect(events[0]!.channel).toBeNull();
  });

  it("treats a verdict row with no interval as covering the recording", () => {
    const events = parsePathologyAnnotations("label\nabnormal\n", { totalSeconds: 600 });
    expect(events[0]).toMatchObject({ startSeconds: 0, stopSeconds: 600, label: "abnormal" });
  });

  it("refuses a file with no label column and drops impossible intervals", () => {
    expect(() => parsePathologyAnnotations("start,stop\n1,2\n")).toThrow(/label column/);
    expect(parsePathologyAnnotations("start,stop,label\n30,10,seizure\n")).toEqual([]);
  });
});

describe("applyAnnotations", () => {
  const events = parsePathologyAnnotations(
    "channel,start_time,stop_time,label\nTERM,0,100,bckg\nTERM,10,22,fnsz\n",
  );

  it("labels only epochs the event really covers", () => {
    const labelled = applyAnnotations([epoch(4), epoch(12), epoch(20)], events);
    expect(labelled[0]!.label).toBe("background");
    expect(labelled[1]!.label).toBe("focal_seizure");
    // 20-24 s is only half-covered by the seizure, so background wins the tie-break on coverage.
    expect(labelled[2]!.label).toBe("focal_seizure");
    expect(labelled[1]!.labelSource).toBe("dataset");
  });

  it("does not label an epoch a seizure clips", () => {
    const labelled = applyAnnotations(
      [epoch(8)],
      parsePathologyAnnotations("start,stop,label\n11,30,seizure\n"),
    );
    expect(labelled[0]!.label).toBeNull();
    expect(labelled[0]!.labelSource).toBe("derived");
  });

  it("ignores events recorded on another channel", () => {
    const labelled = applyAnnotations([epoch(12)], events, { channel: "O2" });
    expect(labelled[0]!.label).toBeNull();
  });

  it("leaves epochs untouched when there are no events", () => {
    expect(applyAnnotations([epoch(0)], [])[0]!.label).toBeNull();
  });
});

describe("epochsFromPathologyRecording", () => {
  const fs = 250;
  const signal = Float64Array.from({ length: fs * 40 }, (_, i) =>
    30 * Math.sin((2 * Math.PI * 9 * i) / fs),
  );

  it("derives features and stamps the collection's own reference", () => {
    const epochs = epochsFromPathologyRecording(signal, fs, {
      dataset: "tusz",
      caseRef: "aaaaaaaa_s001",
      channel: "FP1",
      annotations: parsePathologyAnnotations("start,stop,label\n0,16,fnsz\n"),
    });
    expect(epochs.length).toBeGreaterThan(5);
    expect(epochs[0]!.externalRef.startsWith("tuh-eeg-seizure:aaaaaaaa_s001:FP1:")).toBe(true);
    expect(epochs[0]!.sef95).toBeGreaterThan(0);
    expect(epochs.filter((e) => e.label === "focal_seizure")).toHaveLength(4);
  });

  it("summarises only the expert labels, not the derived ones", () => {
    const epochs = epochsFromPathologyRecording(signal, fs, {
      dataset: "chbmit",
      caseRef: "chb01_03",
      channel: "FP1-F7",
      annotations: parsePathologyAnnotations("start,stop,label\n0,8,seizure\n"),
    });
    const summary = summarisePathologyLabels(epochs);
    expect(summary.labelled).toBe(2);
    expect(summary.seizureEpochs).toBe(2);
    expect(summary.labels[0]).toEqual({ label: "seizure", count: 2 });
    expect(summary.epochs).toBe(epochs.length);
  });
});

describe("toPathologyRows", () => {
  it("keeps each collection under its own lineage with its licence", () => {
    const tusz = toPathologyRows("tusz", [epoch(0)]);
    const tuab = toPathologyRows("tuab", [epoch(0)], { datasetVersion: "v3.0.0" });
    expect(tusz[0]!.sourceLineage).toBe("external:tuh:seizure-corpus");
    expect(tusz[0]!.covariates["pathology_category"]).toBe("seizure");
    expect(tuab[0]!.sourceLineage).toBe("external:tuh:abnormal-corpus");
    expect(tuab[0]!.covariates["pathology_category"]).toBe("cns-disease");
    expect(tuab[0]!.datasetVersion).toBe("v3.0.0");
    expect(String(tuab[0]!.covariates["dataset_licence"]).length).toBeGreaterThan(0);
  });
});
