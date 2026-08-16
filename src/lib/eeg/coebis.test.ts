import { describe, expect, it, afterEach } from "vitest";

import { fitAlignment, alignIndex, fitCoebisKnots, MAX_KNOT_CORRECTION } from "./bis-drift";
import type { BisDriftPoint } from "./bis-drift";
import { computeCoebis, knotCorrection, setActiveBisAlignment } from "./depth";

function point(appIndex: number, bis: number, i: number): BisDriftPoint {
  return {
    at: i,
    bis,
    appIndex,
    sessionId: `s${i % 4}`,
    reliable: true,
    sqi: 0.9,
    recordedAt: new Date(1700000000000 + i * 1000).toISOString(),
  };
}

afterEach(() => setActiveBisAlignment(null));

describe("COEBIS model", () => {
  it("interpolates linearly between knots and holds flat outside", () => {
    const knots = [
      { x: 40, dy: -4 },
      { x: 60, dy: 4 },
    ];
    expect(knotCorrection(20, knots)).toBe(-4);
    expect(knotCorrection(50, knots)).toBe(0);
    expect(knotCorrection(90, knots)).toBe(4);
  });

  it("runs on the baseline correction until a model is active", () => {
    expect(computeCoebis(55)).toBe(55);
    expect(computeCoebis(null)).toBeNull();
    setActiveBisAlignment({ gain: 1, offset: -6, n: 40, fittedAt: "now" });
    expect(computeCoebis(55)).toBe(49);
  });

  it("caps each learned correction", () => {
    const pts = Array.from({ length: 40 }, (_, i) => point(50, 100, i));
    const knots = fitCoebisKnots(pts, { gain: 1, offset: 0 });
    for (const k of knots) expect(Math.abs(k.dy)).toBeLessThanOrEqual(MAX_KNOT_CORRECTION);
  });

  it("reduces mean absolute error against a band-dependent offset", () => {
    // App reads 10 points light when deep, 2 points light when lighter.
    const pts: BisDriftPoint[] = [];
    for (let i = 0; i < 120; i++) {
      const app = 30 + (i % 60);
      const bis = app - (app < 50 ? 10 : 2);
      pts.push(point(app, bis, i));
    }
    const fit = fitAlignment(pts)!;
    expect(fit.maeAfter).toBeLessThan(fit.maeBefore);
    const withKnots = pts.map((p) =>
      Math.abs(alignIndex(p.appIndex, fit) - p.bis),
    );
    const affineOnly = pts.map((p) =>
      Math.abs(alignIndex(p.appIndex, { gain: fit.gain, offset: fit.offset }) - p.bis),
    );
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(mean(withKnots)).toBeLessThan(mean(affineOnly));
  });

  it("keeps COEBIS on the 0-100 scale", () => {
    setActiveBisAlignment({ gain: 1.5, offset: 30, knots: [{ x: 50, dy: 8 }], n: 99, fittedAt: "now" });
    expect(computeCoebis(95)).toBe(100);
    setActiveBisAlignment({ gain: 1, offset: -80, n: 99, fittedAt: "now" });
    expect(computeCoebis(10)).toBe(0);
  });
});
