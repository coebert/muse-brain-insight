import { describe, expect, it } from "vitest";

import { adverseEvents, buildCaseDashboard, outcomeFlag } from "@/lib/eeg/case-dashboard";
import { EMPTY_OUTCOME, type OutcomeCase } from "@/lib/eeg/outcomes";

const caseOf = (over: Partial<OutcomeCase>): OutcomeCase => ({
  sessionId: "s1",
  caseCode: "GA-1",
  ageBand: null,
  startedAt: "2026-01-10T09:00:00Z",
  durationMinutes: 100,
  meanDepth: 45,
  minutesDeep: 10,
  meanSr: 2,
  minutesSuppressed: 5,
  outcome: null,
  ...over,
});

describe("case dashboard", () => {
  it("marks cases without a recovery record as unrecorded", () => {
    expect(outcomeFlag(null)).toBe("unrecorded");
    expect(outcomeFlag({ ...EMPTY_OUTCOME, sessionId: "s1" })).toBe("unrecorded");
  });

  it("names each adverse event and flags the case", () => {
    const outcome = {
      ...EMPTY_OUTCOME,
      sessionId: "s1",
      delirium: "hypoactive",
      emergence: "delayed",
      unplannedIcu: true,
    };
    expect(adverseEvents(outcome)).toEqual([
      "Delirium",
      "Delayed waking",
      "Unplanned intensive care",
    ]);
    expect(outcomeFlag(outcome)).toBe("adverse");
  });

  it("treats an assessed, uneventful recovery as clear", () => {
    const outcome = { ...EMPTY_OUTCOME, sessionId: "s1", delirium: "none", emergence: "smooth" };
    expect(outcomeFlag(outcome)).toBe("clear");
  });

  it("computes shares of the case and sorts newest first", () => {
    const { rows, totals } = buildCaseDashboard([
      caseOf({ sessionId: "old", startedAt: "2025-12-01T09:00:00Z" }),
      caseOf({ sessionId: "new", startedAt: "2026-02-01T09:00:00Z", minutesSuppressed: 20 }),
    ]);
    expect(rows.map((r) => r.sessionId)).toEqual(["new", "old"]);
    expect(rows[0]!.suppressedPercent).toBe(20);
    expect(rows[1]!.deepPercent).toBe(10);
    expect(totals.cases).toBe(2);
    expect(totals.minutesSuppressed).toBe(25);
  });

  it("groups cases by month and marks thin months as unreadable", () => {
    const { trend } = buildCaseDashboard([
      caseOf({ sessionId: "a", startedAt: "2026-01-02T09:00:00Z" }),
      caseOf({ sessionId: "b", startedAt: "2026-01-20T09:00:00Z" }),
      caseOf({ sessionId: "c", startedAt: "2026-01-25T09:00:00Z" }),
      caseOf({ sessionId: "d", startedAt: "2026-02-03T09:00:00Z" }),
    ]);
    expect(trend.map((t) => t.period)).toEqual(["2026-01", "2026-02"]);
    expect(trend[0]!.cases).toBe(3);
    expect(trend[0]!.readable).toBe(true);
    expect(trend[1]!.readable).toBe(false);
  });

  it("ignores cases with no date in the trend but keeps them in the table", () => {
    const { rows, trend } = buildCaseDashboard([caseOf({ startedAt: null })]);
    expect(rows).toHaveLength(1);
    expect(trend).toHaveLength(0);
  });
});
