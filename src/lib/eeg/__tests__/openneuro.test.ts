import { describe, expect, it } from "vitest";

import {
  eventsToStateIntervals,
  eventsUrlFor,
  openNeuroCaseRef,
  openNeuroRows,
  parseBidsEvents,
  parseBidsName,
} from "../openneuro";
import { findSource } from "../dataset-intake";
import type { PhysionetEpoch } from "../physionet";

const EVENTS = [
  "onset\tduration\ttrial_type\tvalue\tsample",
  "82.188\t0.0\tbaseline\t1\t82188",
  "385.205\t0.0\tstart\t6\t385205",
  "496.477\t0.0\tverbal/soft\t9\t496477",
  "895.848\t0.0\tloc\t3\t895848",
  "1970.693\t0.0\troc\t5\t1970693",
].join("\n");

const epoch = (atSeconds: number): PhysionetEpoch => ({
  caseRef: "sub-02_ses-01",
  channel: "AF3",
  atSeconds,
  epochSeconds: 4,
  sampleRate: 1000,
  spectrumDb: [1, 2, 3],
  bands: { delta: 1, theta: 1, alpha: 1, beta: 1, gamma: 1 },
  totalPower: 5,
  sef95: 12,
  suppressionRatio: 0,
  isSuppressed: false,
  label: null,
  labelSource: "derived",
  externalRef: `ref-${atSeconds}`,
});

describe("ds004541 intake", () => {
  it("is registered as its own open lineage", () => {
    const source = findSource("openneuro-ds004541");
    expect(source?.lineage).toBe("external:openneuro:ds004541");
    expect(source?.access).toBe("open");
    expect(source?.binary).toBe(true);
    expect(source?.rangeBytes).toBeGreaterThan(0);
    expect(source?.filePattern.test("sub-02_ses-01_task-anesthesia_eeg.edf")).toBe(true);
    expect(source?.filePattern.test("sub-02_ses-01_task-anesthesia_events.tsv")).toBe(false);
  });

  it("reads BIDS names and the sibling events file", () => {
    expect(parseBidsName("sub-02/ses-01/eeg/sub-02_ses-01_task-anesthesia_eeg.edf")).toEqual({
      subject: "sub-02",
      session: "ses-01",
      task: "anesthesia",
    });
    expect(openNeuroCaseRef("sub-07/ses-02/eeg/sub-07_ses-02_task-anesthesia_eeg.edf")).toBe(
      "sub-07_ses-02",
    );
    expect(eventsUrlFor("https://s3/x/sub-02_ses-01_task-anesthesia_eeg.edf?versionId=abc")).toBe(
      "https://s3/x/sub-02_ses-01_task-anesthesia_events.tsv",
    );
  });

  it("turns markers into state intervals and ignores stimuli", () => {
    const events = parseBidsEvents(EVENTS);
    expect(events).toHaveLength(5);
    const intervals = eventsToStateIntervals(events, 2400);
    expect(intervals.map((i) => i.label)).toEqual([
      "awake",
      "induction",
      "anaesthetised",
      "emergence",
    ]);
    expect(intervals[2]).toMatchObject({ startSeconds: 895.848, stopSeconds: 1970.693 });
    expect(intervals[3]!.stopSeconds).toBe(2400);
  });

  it("keeps epochs in the ds004541 lineage with subject covariates", () => {
    const rows = openNeuroRows([epoch(0), epoch(4)], {
      datasetVersion: "1.0.0",
      fileName: "sub-02/ses-01/eeg/sub-02_ses-01_task-anesthesia_eeg.edf",
      channel: "AF3",
      labelledIntervals: 4,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.sourceLineage).toBe("external:openneuro:ds004541");
    expect(rows[0]!.covariates).toMatchObject({
      subject: "sub-02",
      session: "ses-01",
      setting: "general_anaesthesia",
      channel: "AF3",
    });
  });
});
