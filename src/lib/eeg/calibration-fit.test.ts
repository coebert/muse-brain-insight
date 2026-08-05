import { describe, expect, it } from "vitest";

import {
  evaluate,
  fitCalibration,
  predictIndex,
  TARGETS,
  type CalibrationSample,
  type StateLabel,
} from "@/lib/eeg/calibration";
import { DEFAULT_DEPTH_CALIBRATION, isDefaultCalibration } from "@/lib/eeg/depth";
import { parseDepthCalibration, parseFitMetrics } from "@/lib/eeg/calibration-schema";

/** Mixer inputs that sit roughly where each clinical state lives. */
const ARCHETYPE: Record<StateLabel, Omit<CalibrationSample, "t" | "sessionId" | "label">> = {
  awake: { c1: -6, c2: -12, c3: -12, bsr: 0 },
  sedated: { c1: -12, c2: -22, c3: -8, bsr: 0 },
  anaesthesia: { c1: -18, c2: -32, c3: -3, bsr: 0 },
  burst_suppression: { c1: -22, c2: -50, c3: 2, bsr: 45 },
};

function samples(perState = 20): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  let t = 0;
  (Object.keys(ARCHETYPE) as StateLabel[]).forEach((label) => {
    for (let i = 0; i < perState; i++) {
      const a = ARCHETYPE[label];
      const jitter = (i - perState / 2) * 0.05;
      out.push({
        t: t++,
        sessionId: "s1",
        label,
        c1: a.c1 + jitter,
        c2: a.c2 + jitter,
        c3: a.c3 + jitter,
        bsr: a.bsr,
      });
    }
  });
  return out;
}

describe("evaluate", () => {
  it("summarises only the states present in the training set", () => {
    const metrics = evaluate(samples().filter((s) => s.label === "anaesthesia"), DEFAULT_DEPTH_CALIBRATION);
    expect(metrics.perState).toHaveLength(1);
    expect(metrics.perState[0]!.label).toBe("anaesthesia");
    expect(metrics.samples).toBeGreaterThan(0);
  });

  it("reports NaN metrics for an empty set rather than a misleading zero", () => {
    const metrics = evaluate([], DEFAULT_DEPTH_CALIBRATION);
    expect(metrics.samples).toBe(0);
    expect(Number.isNaN(metrics.rmse)).toBe(true);
    expect(Number.isNaN(metrics.inRangeFraction)).toBe(true);
  });

  it("keeps every prediction on the 0-100 monitor scale", () => {
    for (const s of samples()) {
      const p = predictIndex(s, DEFAULT_DEPTH_CALIBRATION);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });
});

describe("fitCalibration", () => {
  it("improves agreement with the labelled states", () => {
    const fit = fitCalibration(samples());
    expect(fit.after.rmse).toBeLessThanOrEqual(fit.before.rmse);
    expect(fit.after.inRangeFraction).toBeGreaterThanOrEqual(fit.before.inRangeFraction);
  });

  it("is deterministic for the same training set", () => {
    const a = fitCalibration(samples());
    const b = fitCalibration(samples());
    expect(a.calibration).toEqual(b.calibration);
  });

  it("keeps the sigmoids well formed", () => {
    const { calibration } = fitCalibration(samples());
    expect(calibration.sedation.xwidth).toBeGreaterThanOrEqual(0.5);
    expect(calibration.general.xwidth).toBeGreaterThanOrEqual(0.5);
    expect(calibration.general.emax).toBeGreaterThanOrEqual(1);
    expect(calibration.generalLinear.xHi).toBeGreaterThan(calibration.generalLinear.xLo);
  });

  it("stays near the published constants under heavy regularisation", () => {
    const { calibration } = fitCalibration(samples(), 500);
    expect(
      Math.abs(calibration.sedation.x50 - DEFAULT_DEPTH_CALIBRATION.sedation.x50),
    ).toBeLessThan(2);
  });

  it("moves away from the published constants when regularisation is light", () => {
    const { calibration } = fitCalibration(samples(), 0.01);
    expect(isDefaultCalibration(calibration)).toBe(false);
  });

  it("keeps every target band reachable", () => {
    for (const [lo, hi] of Object.values(TARGETS)) {
      expect(hi).toBeGreaterThan(lo);
    }
  });
});

describe("stored calibration validation", () => {
  it("accepts a well formed calibration", () => {
    expect(parseDepthCalibration(DEFAULT_DEPTH_CALIBRATION)).toEqual(DEFAULT_DEPTH_CALIBRATION);
  });

  it("fills in the linear segment for records written before it existed", () => {
    const legacy = {
      sedation: DEFAULT_DEPTH_CALIBRATION.sedation,
      general: DEFAULT_DEPTH_CALIBRATION.general,
    };
    expect(parseDepthCalibration(legacy)?.generalLinear).toEqual(
      DEFAULT_DEPTH_CALIBRATION.generalLinear,
    );
  });

  it("rejects malformed or partial records instead of casting them", () => {
    expect(parseDepthCalibration(null)).toBeNull();
    expect(parseDepthCalibration({ sedation: {}, general: {} })).toBeNull();
    expect(
      parseDepthCalibration({
        sedation: { ...DEFAULT_DEPTH_CALIBRATION.sedation, x50: "steep" },
        general: DEFAULT_DEPTH_CALIBRATION.general,
      }),
    ).toBeNull();
    expect(
      parseDepthCalibration({
        sedation: { ...DEFAULT_DEPTH_CALIBRATION.sedation, xwidth: Number.NaN },
        general: DEFAULT_DEPTH_CALIBRATION.general,
      }),
    ).toBeNull();
  });

  it("keeps unknown metric keys and tolerates a missing metrics column", () => {
    expect(parseFitMetrics({ samples: 12, custom: "x" })).toMatchObject({
      samples: 12,
      custom: "x",
    });
    expect(parseFitMetrics(null)).toEqual({});
  });
});
