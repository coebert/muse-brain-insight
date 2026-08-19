import { describe, expect, it } from "vitest";

import {
  expectedFalseRuns,
  isSeizureEvent,
  summariseSeizureDetections,
  type StoredSeizureEvent,
} from "./seizure-detections";

function ev(t: number, extra: Partial<StoredSeizureEvent> = {}): StoredSeizureEvent {
  return {
    kind: "seizure",
    severity: "warning",
    t_offset_seconds: t,
    duration_seconds: 1,
    detail: null,
    ...extra,
  };
}

describe("summariseSeizureDetections", () => {
  it("merges contiguous alert epochs into one clinical run", () => {
    const s = summariseSeizureDetections([ev(100), ev(101), ev(102)], 600);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ start: 100, end: 103, epochs: 3 });
    expect(s.totalSeconds).toBe(3);
  });

  it("splits runs separated by more than the re-arm gap", () => {
    const s = summariseSeizureDetections([ev(100), ev(400)], 600);
    expect(s.runs).toHaveLength(2);
    expect(s.longestSeconds).toBe(1);
  });

  it("ignores manual markers and other event kinds", () => {
    const s = summariseSeizureDetections(
      [ev(10), ev(20, { kind: "marker" }), ev(30, { kind: "suppression" })],
      600,
    );
    expect(s.runs).toHaveLength(1);
    expect(isSeizureEvent(ev(10))).toBe(true);
    expect(isSeizureEvent(ev(10, { kind: "marker" }))).toBe(false);
  });

  it("takes the worst severity and first detail within a run", () => {
    const s = summariseSeizureDetections(
      [
        ev(10, { severity: "warning", detail: "rhythmic 3 Hz run" }),
        ev(11, { severity: "critical", detail: "escalating" }),
      ],
      600,
    );
    expect(s.runs[0]?.severity).toBe("critical");
    expect(s.runs[0]?.detail).toBe("rhythmic 3 Hz run");
    expect(s.worstSeverity).toBe("critical");
  });

  it("reports burden and rate against recording length", () => {
    const s = summariseSeizureDetections([ev(0, { duration_seconds: 180 })], 3600);
    expect(s.burdenFraction).toBeCloseTo(0.05, 3);
    expect(s.runsPerHour).toBeCloseTo(1, 3);
  });

  it("copes with numeric strings from the database and unsorted rows", () => {
    const s = summariseSeizureDetections(
      [ev(50, { t_offset_seconds: "50", duration_seconds: "2" }), ev(10)],
      600,
    );
    expect(s.runs.map((r) => r.start)).toEqual([10, 50]);
  });

  it("returns an empty summary for a quiet case", () => {
    const s = summariseSeizureDetections([], 600);
    expect(s.runs).toEqual([]);
    expect(s.worstSeverity).toBeNull();
    expect(s.burdenFraction).toBe(0);
    expect(s.runsPerHour).toBe(0);
  });

  it("never reports burden above the whole recording", () => {
    const s = summariseSeizureDetections([ev(0, { duration_seconds: 900 })], 600);
    expect(s.burdenFraction).toBe(1);
  });
});

describe("expectedFalseRuns", () => {
  it("scales the validated false-alarm rate to the case length", () => {
    expect(expectedFalseRuns(1800, 2)).toBeCloseTo(1, 6);
    expect(expectedFalseRuns(1800, 0)).toBe(0);
    expect(expectedFalseRuns(0, 3)).toBe(0);
  });
});
