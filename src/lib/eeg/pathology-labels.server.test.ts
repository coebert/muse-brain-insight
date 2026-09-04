import { describe, expect, it } from "vitest";

import {
  caseCnsLabel,
  datasetCnsLabel,
  datasetSeizureLabel,
  datasetStateLabel,
  monitorSuppressionLabel,
  pairedCaseRef,
} from "./pathology-labels.server";

describe("dataset label extraction", () => {
  it("reads ictal status from annotated intervals", () => {
    expect(datasetSeizureLabel({ seizure_intervals: 2 }, null, null)).toBe("ictal");
    expect(datasetSeizureLabel({ seizure_intervals: 0 }, null, null)).toBe("interictal");
  });

  it("trusts a dataset label but not an app-derived one", () => {
    expect(datasetSeizureLabel(null, "ictal", "dataset")).toBe("ictal");
    expect(datasetSeizureLabel(null, "ictal", "derived")).toBeNull();
  });

  it("maps pathology categories to CNS labels", () => {
    expect(datasetCnsLabel({ pathology_category: "seizure" })).toBe("seizure_disorder");
    expect(datasetCnsLabel({ pathology_category: "healthy control" })).toBe("none");
    expect(datasetCnsLabel({})).toBeNull();
  });
});

describe("case CNS labels", () => {
  it("picks the neurological condition", () => {
    expect(caseCnsLabel(["diabetes", "epilepsy"], [], [])).toBe("epilepsy");
    expect(caseCnsLabel([], ["sepsis", "hypoxic_brain_injury"], [])).toBe("hypoxic_brain_injury");
  });

  it("treats an unfilled form as unknown, not a control", () => {
    expect(caseCnsLabel([], [], [])).toBeNull();
    expect(caseCnsLabel(null, null, null)).toBeNull();
  });

  it("accepts an explicit none as a control", () => {
    expect(caseCnsLabel(["none"], ["none"], [])).toBe("none");
  });

  it("falls back to legacy free-text features", () => {
    expect(caseCnsLabel([], [], ["IHCA", "Stroke"])).toBe("hypoxic_brain_injury");
  });
});

describe("recorded labels from imported datasets", () => {
  it("reads bedside monitor suppression and discards the ambiguous band", () => {
    expect(monitorSuppressionLabel(12)).toBe("suppressed");
    expect(monitorSuppressionLabel(0)).toBe("not_suppressed");
    expect(monitorSuppressionLabel(3)).toBeNull();
    expect(monitorSuppressionLabel(null)).toBeNull();
    // A fraction is normalised to percent before thresholding.
    expect(monitorSuppressionLabel(0.4)).toBe("suppressed");
    expect(monitorSuppressionLabel(0.005)).toBe("not_suppressed");
  });

  it("reads ds004541 event-derived states and ignores app-derived labels", () => {
    expect(datasetStateLabel("anaesthetised", "dataset")).toBe("anaesthetised");
    expect(datasetStateLabel("awake", "dataset")).toBe("awake");
    expect(datasetStateLabel("induction", "dataset")).toBe("induction");
    expect(datasetStateLabel("anaesthetised", "derived")).toBeNull();
    expect(datasetStateLabel(null, "dataset")).toBeNull();
  });

  it("maps paired app readings back to their case", () => {
    expect(
      pairedCaseRef("openneuro-ds004541:sub-02-ses-01-eeg:AF3:143.0"),
    ).toBe("sub-02-ses-01-eeg");
    expect(pairedCaseRef("vitaldb:3:30")).toBe("vitaldb-3");
    expect(pairedCaseRef("nonsense")).toBeNull();
  });
});
