import { describe, expect, it } from "vitest";
import { subsetBis, type LabelledEpoch } from "@/lib/eeg/pathology-labels";

const e = (caseRef: string, coebis: number, bis: number | null, corrected?: number): LabelledEpoch => ({
  lineage: "x", caseRef, atSeconds: 0, labelSource: "dataset", seizure: null, cns: null,
  scores: { coebis, coebisDrugCorrected: corrected ?? null, seizureScore: null, suppressionRatio: 0, sef95: 10, recordedBis: bis },
});
const corrVal = (x: LabelledEpoch) => x.scores.coebisDrugCorrected ?? (x.scores.coebis as number);

describe("subsetBis", () => {
  it("grades only epochs carrying a recorded BIS", () => {
    const r = subsetBis([e("a", 40, 50), e("a", 30, 40), e("b", 20, null)], corrVal);
    expect(r.n).toBe(2);
    expect(r.mae).toBe(10);
    expect(r.bias).toBe(-10);
    expect(r.cases).toBe(1);
  });
  it("says so when no epoch carries a BIS", () => {
    const r = subsetBis([e("a", 40, null)], corrVal);
    expect(r.n).toBe(0);
    expect(r.verdict).toContain("None of the 1 benchmark epochs");
  });
  it("reads the corrected column on the same rows", () => {
    const r = subsetBis([e("a", 40, 50, 45), e("a", 30, 40)], corrVal);
    expect(r.correctedEpochs).toBe(1);
    expect(r.correctedMae).toBe(7.5);
  });
});
