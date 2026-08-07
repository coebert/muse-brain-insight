import { describe, expect, it } from "vitest";

import {
  MIN_POINTS,
  alignIndex,
  analyseBisDrift,
  fitAlignment,
  fitIsSafe,
  type BisDriftPoint,
} from "./bis-drift";

function points(
  n: number,
  offset: number,
  opts: { sessions?: number; gain?: number } = {},
): BisDriftPoint[] {
  const sessions = opts.sessions ?? 4;
  const gain = opts.gain ?? 1;
  return Array.from({ length: n }, (_, i) => {
    const bis = 30 + ((i * 7) % 50);
    return {
      at: i * 60,
      bis,
      appIndex: gain * bis + offset,
      sessionId: `s${i % sessions}`,
      reliable: true,
      sqi: 90,
      recordedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    };
  });
}

describe("analyseBisDrift", () => {
  it("reports no data before any readings are filed", () => {
    const a = analyseBisDrift([]);
    expect(a.verdict).toBe("insufficient");
    expect(a.n).toBe(0);
  });

  it("keeps watching until the point and case thresholds are met", () => {
    const a = analyseBisDrift(points(10, 8, { sessions: 2 }));
    expect(a.verdict).toBe("watching");
    expect(a.readiness.points.have).toBe(10);
    expect(a.bias).toBeCloseTo(8, 5);
  });

  it("does not adjust when the offset is within scatter", () => {
    const a = analyseBisDrift(points(MIN_POINTS + 10, 0.5));
    expect(a.verdict).toBe("aligned");
  });

  it("recommends an adjustment for a persistent positive offset", () => {
    const a = analyseBisDrift(points(MIN_POINTS + 20, 9));
    expect(a.verdict).toBe("adjust");
    expect(a.bias).toBeGreaterThan(8);
    expect(a.readiness.biasSignificant).toBe(true);
    expect(fitIsSafe(a.fit)).toBe(true);
  });

  it("reports an active correction once one is applied", () => {
    const set = points(MIN_POINTS + 20, 9);
    const a = analyseBisDrift(set, { gain: 1, offset: -9 });
    expect(a.verdict).toBe("adjustment_active");
  });

  it("splits the offset by depth band", () => {
    const a = analyseBisDrift(points(MIN_POINTS + 20, 6));
    for (const band of a.bands.filter((b) => b.n > 0)) {
      expect(band.bias).toBeCloseTo(6, 1);
    }
  });
});

describe("fitAlignment", () => {
  it("returns null below five points", () => {
    expect(fitAlignment(points(4, 10))).toBeNull();
  });

  it("recovers an offset and reduces the error", () => {
    const fit = fitAlignment(points(200, 10))!;
    expect(fit.gain).toBeCloseTo(1, 1);
    expect(fit.offset).toBeLessThan(-7);
    expect(fit.maeAfter).toBeLessThan(fit.maeBefore);
    expect(Math.abs(fit.biasAfter)).toBeLessThan(Math.abs(fit.biasBefore));
  });

  it("shrinks toward the identity map on small samples", () => {
    const small = fitAlignment(points(10, 10))!;
    const large = fitAlignment(points(400, 10))!;
    expect(Math.abs(small.offset)).toBeLessThan(Math.abs(large.offset));
  });

  it("rejects a fit that rescales the index implausibly", () => {
    expect(fitIsSafe({ ...fitAlignment(points(200, 10))!, gain: 2.5 })).toBe(false);
    expect(fitIsSafe({ ...fitAlignment(points(200, 10))!, offset: -80 })).toBe(false);
  });
});

describe("alignIndex", () => {
  it("clamps to the 0–100 scale", () => {
    expect(alignIndex(95, { gain: 1.2, offset: 20 })).toBe(100);
    expect(alignIndex(5, { gain: 1, offset: -30 })).toBe(0);
    expect(alignIndex(60, { gain: 1, offset: -8 })).toBe(52);
  });
});
