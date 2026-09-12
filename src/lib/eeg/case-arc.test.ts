import { describe, expect, it } from "vitest";

import { buildCaseArc, type ArcSample } from "./case-arc";
import type { CaseObservation } from "./case-observations";

function trace(): ArcSample[] {
  const out: ArcSample[] = [];
  // 0–120s awake, 120–600s anaesthetised, 600–720s back up.
  for (let t = 0; t <= 720; t += 10) {
    const index = t < 120 ? 92 : t < 600 ? 44 : 85;
    out.push({ t, index, suppression: t > 300 && t < 360 ? 8 : 0, sef: 12 });
  }
  return out;
}

const obs = (over: Partial<CaseObservation>): CaseObservation => ({
  id: Math.random().toString(),
  caseCode: "C1",
  sessionId: null,
  kind: "state",
  atSeconds: 0,
  moaas: null,
  stimulus: null,
  drugName: null,
  dose: null,
  doseUnit: null,
  route: null,
  eventType: null,
  stateLabel: null,
  note: null,
  ...over,
});

describe("buildCaseArc", () => {
  it("splits the case into induction, maintenance and emergence", () => {
    const arc = buildCaseArc(trace());
    expect(arc.phases.map((p) => p.name)).toEqual(["induction", "maintenance", "emergence"]);
    expect(arc.timeToUnconscious).toBe(120);
    expect(arc.phases[1]!.mean).toBeCloseTo(44, 5);
  });

  it("prefers the clinician's own state markers over the index", () => {
    const arc = buildCaseArc(trace(), [
      obs({ atSeconds: 200, stateLabel: "anaesthetised" }),
      obs({ atSeconds: 640, stateLabel: "emergence" }),
    ]);
    expect(arc.phases[0]!.source).toBe("marker");
    expect(arc.timeToUnconscious).toBe(200);
    expect(arc.phases[2]!.start).toBe(640);
  });

  it("counts deep and suppressed time within a phase", () => {
    const arc = buildCaseArc(trace());
    const mid = arc.phases[1]!;
    expect(mid.secondsSuppressed).toBeGreaterThan(0);
    expect(mid.inBand).toBeGreaterThan(0.9);
    expect(arc.phases[0]!.secondsLight).toBeGreaterThan(0);
  });

  it("returns nothing to grade when no index was stored", () => {
    const arc = buildCaseArc([{ t: 0, index: null, suppression: null, sef: null }]);
    expect(arc.hasIndex).toBe(false);
    expect(arc.phases).toEqual([]);
  });

  it("keeps a flat deep case as one maintenance stretch", () => {
    const flat: ArcSample[] = Array.from({ length: 30 }, (_, i) => ({
      t: i * 10,
      index: 45,
      suppression: 0,
      sef: 11,
    }));
    const arc = buildCaseArc(flat);
    expect(arc.phases.map((p) => p.name)).toEqual(["maintenance"]);
  });
});
