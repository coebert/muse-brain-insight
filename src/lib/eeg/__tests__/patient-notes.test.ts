import { describe, expect, it } from "vitest";

import {
  EMPTY_NOTE,
  noteCompleteness,
  patientKeyFor,
  readingCaveat,
  summariseCases,
  type PatientCaseSummary,
  type PatientContextNote,
} from "@/lib/eeg/patient-notes";

const caseOf = (over: Partial<PatientCaseSummary> = {}): PatientCaseSummary => ({
  sessionId: "s1",
  caseCode: "GA-1",
  startedAt: "2026-01-01T09:00:00Z",
  durationMinutes: 60,
  meanSuppressionPct: 4,
  maxSuppressionPct: 12,
  suppressionMinutes: 3,
  seizureAlerts: 0,
  medianIndex: 44,
  minIndex: 30,
  maxIndex: 92,
  ...over,
});

const full: PatientContextNote = {
  context: "frail 84-year-old, emergency laparotomy",
  baseline: "settles at 45–55 on propofol TCI",
  confounders: "dexmedetomidine infusion, intermittent diathermy",
  readWith: "read the index against the suppression trace, not alone",
  updatedAt: "2026-01-02T09:00:00Z",
};

describe("noteCompleteness", () => {
  it("reports nothing written for an empty note", () => {
    const c = noteCompleteness(EMPTY_NOTE);
    expect(c.state).toBe("none");
    expect(c.filled).toBe(0);
    expect(c.missing).toHaveLength(4);
  });

  it("reports partial when some fields are written", () => {
    const c = noteCompleteness({ ...EMPTY_NOTE, context: "septic, ICU sedation" });
    expect(c.state).toBe("partial");
    expect(c.filled).toBe(1);
    expect(c.missing).toHaveLength(3);
  });

  it("treats whitespace as unwritten", () => {
    expect(noteCompleteness({ ...EMPTY_NOTE, baseline: "   " }).state).toBe("none");
  });

  it("reports complete when every field is written", () => {
    const c = noteCompleteness(full);
    expect(c.state).toBe("complete");
    expect(c.missing).toEqual([]);
  });
});

describe("readingCaveat", () => {
  const numbers = summariseCases([caseOf()]);

  it("refuses to interpret numbers with no context at all", () => {
    expect(readingCaveat(numbers, EMPTY_NOTE)).toMatch(/cannot be interpreted/i);
  });

  it("leads with the clinician's own caveat", () => {
    expect(readingCaveat(numbers, full)).toMatch(/^read the index against the suppression trace/);
  });

  it("names suppression as a confounder when suppression was recorded", () => {
    expect(readingCaveat(numbers, full)).toMatch(/3 min of suppression/);
  });

  it("omits suppression wording when none was recorded", () => {
    const clean = summariseCases([caseOf({ suppressionMinutes: 0, meanSuppressionPct: 0 })]);
    expect(readingCaveat(clean, full)).not.toMatch(/suppression recorded/);
  });

  it("flags seizure alerts", () => {
    const alerts = summariseCases([caseOf({ seizureAlerts: 2 })]);
    expect(readingCaveat(alerts, full)).toMatch(/2 seizure-suspicion alerts/);
  });

  it("lists the parts still missing", () => {
    const caveat = readingCaveat(numbers, { ...full, baseline: "" });
    expect(caveat).toMatch(/still missing/i);
  });
});

describe("summariseCases", () => {
  it("rolls several cases into one patient view", () => {
    const n = summariseCases([
      caseOf({ medianIndex: 40, minIndex: 20, suppressionMinutes: 3, seizureAlerts: 1 }),
      caseOf({ sessionId: "s2", medianIndex: 50, minIndex: 35, suppressionMinutes: 2, seizureAlerts: 0 }),
    ]);
    expect(n.cases).toBe(2);
    expect(n.totalMinutes).toBe(120);
    expect(n.medianIndex).toBe(45);
    expect(n.lowestIndex).toBe(20);
    expect(n.suppressionMinutes).toBe(5);
    expect(n.seizureAlerts).toBe(1);
  });

  it("returns nulls rather than zeros when nothing was scored", () => {
    const n = summariseCases([
      caseOf({ medianIndex: null, minIndex: null, meanSuppressionPct: null, maxSuppressionPct: null }),
    ]);
    expect(n.medianIndex).toBeNull();
    expect(n.lowestIndex).toBeNull();
    expect(n.meanSuppressionPct).toBeNull();
  });

  it("handles an empty archive", () => {
    const n = summariseCases([]);
    expect(n).toMatchObject({ cases: 0, totalMinutes: 0, medianIndex: null, seizureAlerts: 0 });
  });
});

describe("patientKeyFor", () => {
  it("groups by the linked patient first", () => {
    expect(
      patientKeyFor({ id: "s1", patient_link_id: "p1", patient_pseudonym: "ABC" }),
    ).toEqual({ key: "patient:p1", linked: true });
  });

  it("falls back to the pseudonym", () => {
    expect(
      patientKeyFor({ id: "s1", patient_link_id: null, patient_pseudonym: "ABC" }),
    ).toEqual({ key: "pseudonym:ABC", linked: true });
  });

  it("treats an unlinked recording as its own case", () => {
    expect(
      patientKeyFor({ id: "s1", patient_link_id: null, patient_pseudonym: null }),
    ).toEqual({ key: "case:s1", linked: false });
  });
});
