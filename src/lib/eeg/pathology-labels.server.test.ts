import { describe, expect, it } from "vitest";

import { caseCnsLabel, datasetCnsLabel, datasetSeizureLabel } from "./pathology-labels.server";

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
