import { describe, it, expect } from "vitest";
import { parseUploadAnnotations, uploadCaseRef, UPLOAD_PRESETS } from "@/lib/eeg/corpus-upload";

describe("corpus upload", () => {
  it("reads BIDS sleep events", () => {
    const r = parseUploadAnnotations("onset\tduration\ttrial_type\n0\t30\tSleep stage W\n30\t30\tSleep stage N2\n60\t30\tSleep stage R\n", "sleep");
    expect(r.annotations.map((a) => a.label)).toEqual(["awake", "sleep_n2", "sleep_rem"]);
  });
  it("reads suppression intervals", () => {
    const r = parseUploadAnnotations("start,stop,label\n0,10,continuous\n10,20,burst_suppression\n", "suppression");
    expect(r.annotations).toHaveLength(2);
  });
  it("derives a case ref", () => {
    expect(uploadCaseRef("sub-03_ses-01_task-sleep_eeg.edf")).toBe("sub-03_ses-01");
  });
  it("has three presets with distinct lineages", () => {
    expect(new Set(UPLOAD_PRESETS.map((p) => p.lineage)).size).toBe(3);
  });
});
