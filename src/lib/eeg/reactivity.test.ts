import { describe, expect, it } from "vitest";

import type { CaseObservation } from "@/lib/eeg/case-observations";
import { buildReactivity, describeChange, reactivityMarks } from "@/lib/eeg/reactivity";

function mark(atSeconds: number, over: Partial<CaseObservation> = {}): CaseObservation {
  return {
    id: `m${atSeconds}`,
    caseCode: "C1",
    sessionId: null,
    kind: "responsiveness",
    atSeconds,
    moaas: 1,
    stimulus: "trapezius",
    drugName: null,
    dose: null,
    doseUnit: null,
    route: null,
    eventType: null,
    note: null,
    ...over,
  };
}

const epochs = Array.from({ length: 60 }, (_, i) => ({
  t: i * 5,
  depth: { index: i * 5 < 150 ? 40 : 60 },
  sef95: 12,
  suppressionRatio: 0,
  seizureScore: 0,
}));

describe("reactivity", () => {
  it("measures the depth change either side of a mark", () => {
    const [row] = buildReactivity([mark(150)], epochs, { seconds: 60 });
    expect(row?.depth.before).toBe(40);
    expect(row?.depth.after).toBe(60);
    expect(row?.depth.change).toBe(20);
    expect(row?.beforeCount).toBeGreaterThan(0);
    expect(row?.afterCount).toBeGreaterThan(0);
  });

  it("drops marks with no trace around them", () => {
    expect(buildReactivity([mark(9000)], epochs)).toHaveLength(0);
  });

  it("keeps stimulus and seizure events but not drugs or artefact", () => {
    const rows = reactivityMarks([
      mark(10, { kind: "event", moaas: null, stimulus: null, eventType: "stimulus" }),
      mark(20, { kind: "event", moaas: null, stimulus: null, eventType: "artefact" }),
      mark(30, { kind: "drug", moaas: null, stimulus: null, drugName: "Propofol" }),
      mark(40),
    ]);
    expect(rows.map((r) => r.atSeconds)).toEqual([10, 40]);
  });

  it("calls small moves no change", () => {
    expect(describeChange(0.4)).toBe("no change");
    expect(describeChange(null)).toBe("not measurable");
    expect(describeChange(-6)).toContain("fell");
  });
});
