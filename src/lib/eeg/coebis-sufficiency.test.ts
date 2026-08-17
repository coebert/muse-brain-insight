import { describe, expect, it } from "vitest";

import { evaluateCoebisSufficiency } from "./coebis-sufficiency";
import type { BisDriftAnalysis } from "./bis-drift";

function analysis(over: Partial<BisDriftAnalysis> = {}): BisDriftAnalysis {
  return {
    n: 40,
    nReliable: 36,
    sessions: 4,
    bias: 6,
    sd: 5,
    ci: [4, 8],
    designEffect: 1,
    icc: 0,
    nTransitional: 0,
    mae: 6,
    r: 0.9,
    bands: [
      { band: "light", n: 12, bias: 5, meanAbsolute: 5 },
      { band: "surgical", n: 20, bias: 6, meanAbsolute: 6 },
      { band: "deep", n: 8, bias: 7, meanAbsolute: 7 },
    ],
    recent: { n: 20, bias: 6.5 },
    fit: {
      gain: 0.95,
      offset: -3,
      knots: [],
      n: 40,
      sessions: 4,
      biasBefore: 6,
      biasAfter: 0.3,
      maeBefore: 6,
      maeAfter: 2.8,
    },
    verdict: "adjustment_active",
    tier: "confirmed",
    summary: "",
    readiness: {
      points: { have: 40, need: 30 },
      sessions: { have: 4, need: 3 },
      provisional: { points: 8, sessions: 2, met: true },
      biasSignificant: true,
    },
    ...over,
  };
}

describe("COEBIS sufficiency", () => {
  it("reports no model with no pooled analysis", () => {
    const s = evaluateCoebisSufficiency(null);
    expect(s.tier).toBe("none");
    expect(s.score).toBeNull();
    expect(s.nextStep).toContain("8 readings");
  });

  it("scores a well-evidenced confirmed model highly", () => {
    const s = evaluateCoebisSufficiency(analysis());
    expect(s.tier).toBe("confirmed");
    expect(s.score!).toBeGreaterThanOrEqual(75);
    expect(s.scoreLabel).toBe("Strong");
    expect(s.failed).toBe(0);
  });

  it("explains what is missing for a provisional model", () => {
    const s = evaluateCoebisSufficiency(
      analysis({
        n: 10,
        nReliable: 9,
        sessions: 2,
        tier: "provisional",
        readiness: {
          points: { have: 10, need: 30 },
          sessions: { have: 2, need: 3 },
          provisional: { points: 8, sessions: 2, met: true },
          biasSignificant: true,
        },
      }),
    );
    expect(s.tier).toBe("provisional");
    expect(s.nextStep).toContain("20 more paired readings");
    expect(s.nextStep).toContain("1 more case");
    const readings = s.checks.find((c) => c.id === "readings")!;
    expect(readings.status).toBe("partial");
  });

  it("fails the guard-rail check on an implausible gain", () => {
    const s = evaluateCoebisSufficiency(
      analysis({ fit: { ...analysis().fit!, gain: 2.4 } }),
    );
    expect(s.checks.find((c) => c.id === "guardrails")!.status).toBe("fail");
    expect(s.failed).toBeGreaterThan(0);
  });

  it("flags missing depth-band coverage", () => {
    const s = evaluateCoebisSufficiency(
      analysis({
        bands: [
          { band: "light", n: 40, bias: 6, meanAbsolute: 6 },
          { band: "surgical", n: 0, bias: null, meanAbsolute: null },
          { band: "deep", n: 0, bias: null, meanAbsolute: null },
        ],
      }),
    );
    const coverage = s.checks.find((c) => c.id === "coverage")!;
    expect(coverage.status).toBe("fail");
    expect(coverage.detail).toContain("surgical");
  });

  it("flags an offset that has moved recently", () => {
    const s = evaluateCoebisSufficiency(analysis({ recent: { n: 20, bias: 20 } }));
    expect(s.checks.find((c) => c.id === "stability")!.status).toBe("fail");
  });
});