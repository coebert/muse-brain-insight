import { describe, expect, it } from "vitest";

import {
  BRAINVISION_DEPTH_SOURCE,
  CONDITION_DEPTH_ANCHORS,
  brainVisionDepthLineageKey,
  buildConditionDepthPoints,
} from "../brainvision-depth";
import type { ReplayFrame } from "../replay";

function frames(count: number, index = 70): ReplayFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    t: i,
    appIndex: index,
    sef95: 14,
    suppressionRatio: 0,
  })) as unknown as ReplayFrame[];
}

describe("condition-referenced depth pairing", () => {
  it("pairs a sedated recording against the sedation anchor", () => {
    const built = buildConditionDepthPoints(frames(60), {
      caseRef: "sub-1016_task-sed",
      channel: "Fp1",
      state: "sedated",
      durationSeconds: 60,
    });
    expect(built.points.length).toBeGreaterThan(0);
    expect(built.points.every((p) => p.reference === CONDITION_DEPTH_ANCHORS["sedated"]!.depth)).toBe(true);
    expect(built.points[0]!.externalRef.startsWith(BRAINVISION_DEPTH_SOURCE)).toBe(true);
    // The guard band keeps the first and last ten seconds out of the fit.
    expect(built.points[0]!.atSeconds).toBeGreaterThanOrEqual(10);
    expect(built.points.at(-1)!.atSeconds).toBeLessThanOrEqual(50);
  });

  it("refuses a recording with no published condition", () => {
    const built = buildConditionDepthPoints(frames(60), {
      caseRef: "sub-1016_task-unknown",
      channel: "Fp1",
      state: null,
      durationSeconds: 60,
    });
    expect(built.points).toHaveLength(0);
  });

  it("keeps its own acquisition lineage", () => {
    expect(brainVisionDepthLineageKey("Fp1", 5000)).toContain("openneuro-ds005620");
    expect(brainVisionDepthLineageKey("Fp1", 5000)).not.toContain("ds004541");
  });
});
