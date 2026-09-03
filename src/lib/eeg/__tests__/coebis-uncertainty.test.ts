import { describe, expect, it } from "vitest";

import {
  calibrationReport,
  localVolatility,
  modelSigma,
  predictionInterval,
} from "../coebis-uncertainty";
import type { BisAlignment } from "../depth";

const model = (over: Partial<BisAlignment> = {}): BisAlignment => ({
  gain: 1,
  offset: 0,
  n: 120,
  fittedAt: "2026-01-01T00:00:00.000Z",
  maeAfter: 4,
  ...over,
});

describe("modelSigma", () => {
  it("widens without a fitted model and for provisional fits", () => {
    expect(modelSigma(null)).toBeGreaterThan(modelSigma(model()));
    expect(modelSigma(model({ provisional: true }))).toBeGreaterThan(modelSigma(model()));
  });

  it("shrinks as held-out error falls", () => {
    expect(modelSigma(model({ maeAfter: 2 }))).toBeLessThan(modelSigma(model({ maeAfter: 8 })));
  });

  it("inflates a fit built on very few readings", () => {
    expect(modelSigma(model({ n: 4 }))).toBeGreaterThan(modelSigma(model({ n: 400 })));
  });
});

describe("predictionInterval", () => {
  it("returns nothing without a prediction", () => {
    expect(predictionInterval({ prediction: null }, model())).toBeNull();
  });

  it("brackets the prediction and stays inside the index scale", () => {
    const iv = predictionInterval({ prediction: 45 }, model())!;
    expect(iv.lower).toBeLessThan(45);
    expect(iv.upper).toBeGreaterThan(45);
    const edge = predictionInterval({ prediction: 2 }, null)!;
    expect(edge.lower).toBe(0);
    expect(predictionInterval({ prediction: 99 }, null)!.upper).toBe(100);
  });

  it("widens for unreliable seconds, poor signal, suppression and volatility", () => {
    const base = predictionInterval({ prediction: 45 }, model())!.sigma;
    expect(predictionInterval({ prediction: 45, reliable: false }, model())!.sigma).toBeGreaterThan(base);
    expect(predictionInterval({ prediction: 45, sqi: 0.2 }, model())!.sigma).toBeGreaterThan(base);
    expect(
      predictionInterval({ prediction: 45, suppressionRatio: 60 }, model())!.sigma,
    ).toBeGreaterThan(base);
    expect(predictionInterval({ prediction: 45, volatility: 8 }, model())!.sigma).toBeGreaterThan(base);
  });

  it("widens when the patient terms cannot be applied", () => {
    const withTerms = model({ terms: [{ group: "age", level: "60-74", delta: 2, n: 40 }] as never });
    const known = predictionInterval({ prediction: 45, covariatesKnown: true }, withTerms)!;
    const unknown = predictionInterval({ prediction: 45, covariatesKnown: false }, withTerms)!;
    expect(unknown.sigma).toBeGreaterThan(known.sigma);
    expect(unknown.drivers).toContain("patient covariates unknown");
  });

  it("uses a wider band for a higher level", () => {
    const a = predictionInterval({ prediction: 45 }, model(), 0.5)!;
    const b = predictionInterval({ prediction: 45 }, model(), 0.9)!;
    expect(b.upper - b.lower).toBeGreaterThan(a.upper - a.lower);
  });
});

describe("calibrationReport", () => {
  const samples = (sd: number, n = 400) =>
    Array.from({ length: n }, (_, i) => {
      // Deterministic pseudo-normal draw via the Box-Muller transform.
      const u1 = ((i * 37) % n) / n + 1 / (2 * n);
      const u2 = ((i * 91) % n) / n + 1 / (2 * n);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return { prediction: 50, sigma: 5, actual: 50 + z * sd };
    });

  it("refuses to score too few readings", () => {
    const r = calibrationReport(samples(5, 4));
    expect(r.verdict).toBe("insufficient");
    expect(r.levels).toEqual([]);
  });

  it("calls a matching spread well calibrated", () => {
    const r = calibrationReport(samples(5));
    expect(r.verdict).toBe("well-calibrated");
    expect(r.zSpread).toBeGreaterThan(0.85);
    expect(r.zSpread).toBeLessThan(1.15);
    expect(r.levels.find((l) => l.nominal === 0.9)!.empirical).toBeGreaterThan(0.83);
  });

  it("flags intervals that are too narrow", () => {
    const r = calibrationReport(samples(12));
    expect(r.verdict).toBe("overconfident");
    expect(r.zSpread).toBeGreaterThan(1.5);
    expect(r.summary).toMatch(/too narrow/);
  });

  it("flags intervals that are wider than needed", () => {
    const r = calibrationReport(samples(1));
    expect(r.verdict).toBe("conservative");
  });
});

describe("localVolatility", () => {
  it("is null without enough neighbours and rises with movement", () => {
    expect(localVolatility([null, 4, null], 1, 1)).toBeNull();
    const flat = localVolatility([50, 50, 50, 50, 50], 2, 2)!;
    const moving = localVolatility([30, 40, 50, 60, 70], 2, 2)!;
    expect(flat).toBe(0);
    expect(moving).toBeGreaterThan(flat);
  });
});
