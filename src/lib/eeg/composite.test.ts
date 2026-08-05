import { describe, expect, it } from "vitest";

import {
  CompositeIndexEstimator,
  compositeBand,
  nociceptionBand,
  type CompositeInput,
} from "@/lib/eeg/composite";

function input(over: Partial<CompositeInput> = {}): CompositeInput {
  return {
    bands: { delta: 10, theta: 6, alpha: 5, beta: 3, gamma: 1 },
    ratios: { deltaAlpha: 2, betaAlpha: 0.6, thetaAlpha: 1.2 },
    entropy: { shannon: 0.7, se95: 0.7, state: 0.7, response: 0.75 },
    suppressionRatio: 0,
    usable: true,
    ...over,
  } as CompositeInput;
}

function settle(est: CompositeIndexEstimator, over: Partial<CompositeInput>, epochs = 60) {
  let reading = est.update(input(over));
  for (let i = 0; i < epochs; i++) reading = est.update(input(over));
  return reading;
}

describe("band labelling", () => {
  it("maps the consciousness scale onto clinical bands", () => {
    expect(compositeBand(null, 0)).toBe("unreliable");
    expect(compositeBand(90, 0)).toBe("awake");
    expect(compositeBand(70, 0)).toBe("light_sedation");
    expect(compositeBand(50, 0)).toBe("surgical");
    expect(compositeBand(30, 0)).toBe("deep");
    expect(compositeBand(10, 0)).toBe("burst_suppression");
  });

  it("calls any suppression burden burst suppression", () => {
    expect(compositeBand(55, 8)).toBe("burst_suppression");
  });

  it("maps the nociception scale", () => {
    expect(nociceptionBand(null)).toBe("unreliable");
    expect(nociceptionBand(20)).toBe("well_controlled");
    expect(nociceptionBand(50)).toBe("adequate");
    expect(nociceptionBand(80)).toBe("likely_response");
  });
});

describe("CompositeIndexEstimator", () => {
  it("withholds both indices until ~10 s of clean data", () => {
    const est = new CompositeIndexEstimator();
    for (let i = 0; i < 9; i++) {
      const r = est.update(input());
      expect(r.cIndex).toBeNull();
      expect(r.nIndex).toBeNull();
    }
    const tenth = est.update(input());
    expect(tenth.cIndex).not.toBeNull();
    expect(tenth.nIndex).not.toBeNull();
  });

  it("scores a fast, high-entropy spectrum above a slow one", () => {
    const awake = settle(new CompositeIndexEstimator(), {
      bands: { delta: 2, theta: 2, alpha: 4, beta: 8, gamma: 4 },
      ratios: { deltaAlpha: 0.5, betaAlpha: 2, thetaAlpha: 0.5 },
      entropy: { shannon: 0.9, se95: 0.9, state: 0.9, response: 0.92 },
    });
    const anaesthetised = settle(new CompositeIndexEstimator(), {
      bands: { delta: 40, theta: 10, alpha: 6, beta: 1, gamma: 0.2 },
      ratios: { deltaAlpha: 6.7, betaAlpha: 0.17, thetaAlpha: 1.7 },
      entropy: { shannon: 0.4, se95: 0.4, state: 0.35, response: 0.37 },
    });
    expect(awake.cIndex!).toBeGreaterThan(anaesthetised.cIndex!);
  });

  it("collapses the consciousness index under heavy suppression", () => {
    const suppressed = settle(new CompositeIndexEstimator(), { suppressionRatio: 60 });
    expect(suppressed.cIndex!).toBeLessThan(20);
    expect(suppressed.cBand).toBe("burst_suppression");
  });

  it("damps the nociception index when the cortex is suppressed", () => {
    const highDrive = {
      bands: { delta: 5, theta: 3, alpha: 3, beta: 6, gamma: 6 },
      ratios: { deltaAlpha: 1.7, betaAlpha: 2, thetaAlpha: 1 },
      entropy: { shannon: 0.8, se95: 0.8, state: 0.6, response: 0.9 },
    };
    const awake = settle(new CompositeIndexEstimator(), highDrive);
    const suppressed = settle(new CompositeIndexEstimator(), {
      ...highDrive,
      suppressionRatio: 50,
    });
    expect(suppressed.nIndex!).toBeLessThan(awake.nIndex!);
  });

  it("holds the last clean value across an artefact-rejected epoch", () => {
    const est = new CompositeIndexEstimator();
    const clean = settle(est, {});
    const held = est.update(input({ usable: false }));
    expect(held.held).toBe(true);
    expect(held.cIndex).toBe(clean.cIndex);
    expect(held.nIndex).toBe(clean.nIndex);
  });

  it("starts fresh after reset", () => {
    const est = new CompositeIndexEstimator();
    settle(est, {});
    est.reset();
    expect(est.update(input()).cIndex).toBeNull();
  });
});
