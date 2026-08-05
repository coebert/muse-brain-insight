import { describe, expect, it } from "vitest";

import {
  assessEvidence,
  assessSessionCoverage,
  assessWindowCoverage,
  epochCadence,
  normaliseThresholds,
  worstLevel,
  type CoverageEpoch,
} from "@/lib/eeg/coverage";
import type { AlertEvidence } from "@/lib/eeg/interpret.functions";

function epochs(times: number[], over: Partial<CoverageEpoch> = {}): CoverageEpoch[] {
  return times.map((t) => ({
    t,
    depth: 45,
    sef95: 12,
    sr: 0,
    seizure: 0.1,
    entropy: 0.7,
    spectrumBins: 64,
    ...over,
  }));
}

const range = (from: number, to: number, step = 1) => {
  const out: number[] = [];
  for (let t = from; t <= to; t += step) out.push(t);
  return out;
};

describe("epochCadence", () => {
  it("uses the median spacing of stored epochs", () => {
    expect(epochCadence(epochs([0, 2, 4, 6]))).toBe(2);
  });

  it("falls back to one second when there is nothing to measure", () => {
    expect(epochCadence([])).toBe(1);
    expect(epochCadence(epochs([5]))).toBe(1);
  });
});

describe("assessWindowCoverage", () => {
  it("passes a fully covered window", () => {
    const c = assessWindowCoverage(epochs(range(0, 120)), 60, 90);
    expect(c.level).toBe("ok");
    expect(c.fraction).toBeCloseTo(1, 1);
    expect(c.missingMetrics).toEqual([]);
  });

  it("flags a window with no stored EEG as insufficient", () => {
    const c = assessWindowCoverage(epochs(range(0, 30)), 200, 260);
    expect(c.present).toBe(0);
    expect(c.level).toBe("insufficient");
    expect(c.largestGapSeconds).toBeGreaterThan(0);
  });

  it("flags a mid-window recording gap as partial", () => {
    const times = [...range(0, 60), ...range(70, 120)];
    const c = assessWindowCoverage(epochs(times), 50, 90);
    expect(c.largestGapSeconds).toBeGreaterThan(5);
    expect(c.level).not.toBe("ok");
  });

  it("names metrics that were gated out", () => {
    const c = assessWindowCoverage(epochs(range(0, 60), { depth: null }), 10, 40);
    expect(c.missingMetrics).toContain("depth index");
    expect(c.level).toBe("partial");
  });

  it("calls a window with no spectra insufficient — there is no DSA to review", () => {
    const c = assessWindowCoverage(epochs(range(0, 60), { spectrumBins: 0 }), 10, 40);
    expect(c.spectrumMissingFraction).toBe(1);
    expect(c.level).toBe("insufficient");
  });
});

describe("assessSessionCoverage", () => {
  it("passes a complete session", () => {
    const c = assessSessionCoverage(epochs(range(0, 600)), 600);
    expect(c.level).toBe("ok");
    expect(c.missingSeconds).toBe(0);
  });

  it("locates the worst gap in the recording", () => {
    const times = [...range(0, 100), ...range(200, 300)];
    const c = assessSessionCoverage(epochs(times), 300);
    expect(c.worstGapSeconds).toBeGreaterThan(90);
    expect(c.worstGapAtSeconds).toBeCloseTo(101, 0);
    expect(c.level).toBe("insufficient");
  });

  it("counts recording that stopped before the session ended", () => {
    const c = assessSessionCoverage(epochs(range(0, 100)), 400);
    expect(c.missingSeconds).toBeGreaterThan(290);
    expect(c.level).toBe("insufficient");
  });

  it("honours relaxed thresholds", () => {
    const times = [...range(0, 100), ...range(140, 300)];
    const strict = assessSessionCoverage(epochs(times), 300);
    const relaxed = assessSessionCoverage(
      epochs(times),
      300,
      normaliseThresholds({
        sessionCoverageInsufficient: 0.1,
        sessionCoveragePartial: 0.2,
        sessionGapCadences: 500,
      }),
    );
    expect(strict.level).not.toBe("ok");
    expect(relaxed.level).toBe("ok");
  });
});

describe("assessEvidence", () => {
  const feature = (over: Partial<AlertEvidence> = {}): AlertEvidence =>
    ({
      feature: "SEF95",
      value: "9 Hz",
      weight: 0.4,
      windowStartSeconds: 10,
      windowEndSeconds: 40,
      ...over,
    }) as AlertEvidence;

  it("passes complete evidence", () => {
    expect(assessEvidence([feature(), feature()]).level).toBe("ok");
  });

  it("treats an alert with no evidence as insufficient", () => {
    const e = assessEvidence([]);
    expect(e.level).toBe("insufficient");
    expect(e.reasons[0]).toMatch(/No evidence/);
  });

  it("explains which parts of the evidence are missing", () => {
    const e = assessEvidence([feature(), feature({ value: "" })]);
    expect(e.level).toBe("partial");
    expect(e.reasons.join(" ")).toMatch(/without a value/);
  });

  it("calls mostly-empty evidence insufficient", () => {
    const e = assessEvidence([feature({ weight: 0 }), feature({ weight: 0 }), feature()]);
    expect(e.level).toBe("insufficient");
  });
});

describe("worstLevel", () => {
  it("keeps the more serious of two judgements", () => {
    expect(worstLevel("ok", "partial")).toBe("partial");
    expect(worstLevel("insufficient", "partial")).toBe("insufficient");
    expect(worstLevel("ok", "ok")).toBe("ok");
  });
});

describe("normaliseThresholds", () => {
  it("ignores missing and invalid overrides", () => {
    const t = normaliseThresholds({ windowCoveragePartial: 0.7, sessionGapCadences: -3 });
    expect(t.windowCoveragePartial).toBe(0.7);
    expect(t.sessionGapCadences).toBe(5);
  });
});
