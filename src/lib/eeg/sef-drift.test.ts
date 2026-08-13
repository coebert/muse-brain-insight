import { describe, expect, it } from "vitest";

import {
  analyseSefDrift,
  applySefAlignment,
  fitSefAlignment,
  sefFitIsSafe,
  type SefDriftPoint,
} from "./sef-drift";

/** Paired readings where the headband reads a fixed amount faster. */
function pairs(n: number, offsetHz: number, sessions = 3): SefDriftPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const monitor = 9 + (i % 7);
    return {
      at: i * 60,
      monitorSef: monitor,
      appSef: monitor + offsetHz,
      sessionId: `case-${i % sessions}`,
      reliable: true,
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    };
  });
}

describe("SEF alignment", () => {
  it("holds off until there is enough paired evidence", () => {
    const a = analyseSefDrift(pairs(4, 2));
    expect(a.verdict).toBe("watching");
  });

  it("fits a correction that removes a consistent offset", () => {
    const fit = fitSefAlignment(pairs(40, 2));
    expect(fit).not.toBeNull();
    expect(sefFitIsSafe(fit)).toBe(true);
    expect(fit!.maeAfter).toBeLessThan(fit!.maeBefore);
    expect(applySefAlignment(13, fit!)).toBeLessThan(13);
  });

  it("leaves SEF alone when the headband already agrees", () => {
    const a = analyseSefDrift(pairs(40, 0));
    expect(a.verdict).toBe("aligned");
    expect(Math.abs(a.bias ?? 99)).toBeLessThan(0.5);
  });

  it("labels an early fit provisional rather than confirmed", () => {
    const a = analyseSefDrift(pairs(10, 2, 2));
    expect(a.verdict).toBe("provisional");
    expect(a.readiness.provisional.met).toBe(true);
  });

  it("returns the raw value when no correction is in force", () => {
    expect(applySefAlignment(12.5, null)).toBe(12.5);
  });
});