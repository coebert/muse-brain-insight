import { describe, expect, it } from "vitest";

import {
  captureGaps,
  drugTally,
  transitionsOf,
  validateDraft,
  type CaseObservation,
} from "@/lib/eeg/case-observations";

function score(atSeconds: number, moaas: number): CaseObservation {
  return {
    id: `s${atSeconds}`,
    caseCode: "C1",
    sessionId: null,
    kind: "responsiveness",
    atSeconds,
    moaas,
    stimulus: "name",
    drugName: null,
    dose: null,
    doseUnit: null,
    route: null,
    note: null,
  };
}

function drug(atSeconds: number, drugName: string): CaseObservation {
  return {
    id: `d${atSeconds}-${drugName}`,
    caseCode: "C1",
    sessionId: null,
    kind: "drug",
    atSeconds,
    moaas: null,
    stimulus: null,
    drugName,
    dose: 100,
    doseUnit: "mg",
    route: "iv-bolus",
    note: null,
  };
}

describe("transitionsOf", () => {
  it("reads loss and return of responsiveness from the scores", () => {
    const t = transitionsOf([score(0, 5), score(120, 1), score(300, 0), score(900, 4)]);
    expect(t.lossOfResponsivenessAt).toBe(120);
    expect(t.returnOfResponsivenessAt).toBe(900);
    expect(t.lowestScore).toBe(0);
    expect(t.scoreCount).toBe(4);
  });

  it("leaves return open while the patient is still unresponsive", () => {
    const t = transitionsOf([score(0, 5), score(60, 0)]);
    expect(t.lossOfResponsivenessAt).toBe(60);
    expect(t.returnOfResponsivenessAt).toBeNull();
  });

  it("reports nothing when no score has been taken", () => {
    const t = transitionsOf([drug(10, "Propofol")]);
    expect(t.scoreCount).toBe(0);
    expect(t.lossOfResponsivenessAt).toBeNull();
    expect(t.lowestScore).toBeNull();
  });

  it("is order independent", () => {
    const t = transitionsOf([score(900, 4), score(120, 1), score(0, 5)]);
    expect(t.lossOfResponsivenessAt).toBe(120);
    expect(t.returnOfResponsivenessAt).toBe(900);
  });
});

describe("drugTally", () => {
  it("counts repeat doses and keeps first and last times", () => {
    const tally = drugTally([drug(10, "Propofol"), drug(400, "Propofol"), drug(20, "Fentanyl")]);
    const propofol = tally.find((t) => t.drugName === "Propofol")!;
    expect(propofol.doses).toBe(2);
    expect(propofol.firstAtSeconds).toBe(10);
    expect(propofol.lastAtSeconds).toBe(400);
    expect(tally).toHaveLength(2);
  });
});

describe("captureGaps", () => {
  it("names what is still missing", () => {
    expect(captureGaps([])).toContain("No responsiveness score recorded yet");
    expect(captureGaps([score(0, 5), drug(10, "Propofol")])).toContain(
      "Loss of responsiveness not captured",
    );
  });

  it("is quiet once a full case is captured", () => {
    expect(captureGaps([score(0, 5), score(60, 0), score(900, 5), drug(10, "Propofol")])).toEqual(
      [],
    );
  });
});

describe("validateDraft", () => {
  it("rejects an out-of-range score", () => {
    const result = validateDraft({
      kind: "responsiveness",
      atSeconds: 10,
      moaas: 7,
      stimulus: "name",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a dose without a unit", () => {
    const result = validateDraft({
      kind: "drug",
      atSeconds: 10,
      drugName: "Propofol",
      dose: 100,
      doseUnit: null,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a drug with no dose given", () => {
    const result = validateDraft({ kind: "drug", atSeconds: 10, drugName: "Sevoflurane" });
    expect(result.ok).toBe(true);
  });
});
