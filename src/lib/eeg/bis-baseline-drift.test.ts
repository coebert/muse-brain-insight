import { describe, expect, it } from "vitest";

import { baselineDriftSeries } from "./bis-baseline-drift";
import type { BisDriftSeriesPoint } from "./bis-drift.functions";

const pt = (
  i: number,
  sessionId: string | null,
  raw: number,
  corrected: number | null = null,
): BisDriftSeriesPoint => ({
  i,
  bis: raw,
  raw,
  corrected,
  reliable: true,
  recordedAt: new Date(i * 1000).toISOString(),
  sessionId,
});

describe("baselineDriftSeries", () => {
  it("anchors a baseline per case and reports drift from it", () => {
    const out = baselineDriftSeries([
      pt(1, "a", 90),
      pt(2, "a", 92),
      pt(3, "a", 88),
      pt(4, "a", 50),
    ]);
    expect(out[0]?.baseline).toBe(90);
    expect(out[3]?.drift).toBe(-40);
  });

  it("keeps cases independent and flags case boundaries", () => {
    const out = baselineDriftSeries([pt(1, "a", 80), pt(2, "b", 40), pt(3, "b", 30)]);
    expect(out[0]?.drift).toBe(0);
    expect(out[1]?.caseStart).toBe(true);
    expect(out[2]?.baseline).toBe(35);
    expect(out[2]?.drift).toBe(-5);
  });

  it("prefers the corrected COEBIS value when present", () => {
    const out = baselineDriftSeries([pt(1, "a", 90, 70), pt(2, "a", 90, 60)]);
    expect(out[0]?.baseline).toBe(65);
    expect(out[1]?.drift).toBe(-5);
  });
});
