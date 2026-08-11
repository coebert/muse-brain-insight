import { describe, expect, it } from "vitest";

import { MIN_WINDOW, detectCoebisDrift } from "./coebis-drift-watch";
import type { ResidualInput } from "./coebis-residuals";

function rows(residuals: number[]): ResidualInput[] {
  return residuals.map((residual, i) => ({
    residual,
    bis: 50,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    caseCode: `C${i % 3}`,
    usedInFit: true,
  }));
}

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("detectCoebisDrift", () => {
  it("reports insufficient history below the window size", () => {
    const d = detectCoebisDrift(rows(flat(10, 1)), 5);
    expect(d.status).toBe("insufficient");
    expect(d.psi).toBeNull();
  });

  it("calls steady agreement stable", () => {
    const d = detectCoebisDrift(rows(flat(120, 1)), 5);
    expect(d.status).toBe("stable");
    expect(d.percentDelta).toBe(0);
  });

  it("flags drift when percent within tolerance collapses", () => {
    const d = detectCoebisDrift(rows([...flat(100, 1), ...flat(60, 12)]), 5);
    expect(d.status).toBe("drifting");
    expect(d.percentDelta!).toBeLessThan(-15);
    expect(d.recent.percentWithin).toBe(0);
  });

  it("flags a histogram shift even while readings stay in tolerance", () => {
    const d = detectCoebisDrift(rows([...flat(100, -4), ...flat(60, 4)]), 5);
    expect(d.status).not.toBe("stable");
    expect(Math.abs(d.biasDelta!)).toBeGreaterThanOrEqual(4);
    expect(d.psi!).toBeGreaterThan(0.25);
  });

  it("keeps each window at least the minimum size", () => {
    const d = detectCoebisDrift(rows(flat(MIN_WINDOW * 2, 0)), 5);
    expect(d.recent.n).toBeGreaterThanOrEqual(MIN_WINDOW);
    expect(d.baseline.n).toBeGreaterThanOrEqual(MIN_WINDOW);
  });
});
