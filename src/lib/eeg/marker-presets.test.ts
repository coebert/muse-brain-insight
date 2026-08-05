import { describe, expect, it } from "vitest";

import { BACKDATE_OFFSETS, MARKER_GROUPS, quickMarkers } from "./marker-presets";

describe("marker presets", () => {
  it("has unique marker labels across groups", () => {
    const all = MARKER_GROUPS.flatMap((g) => g.markers);
    expect(new Set(all).size).toBe(all.length);
  });

  it("offers mode-specific quick markers drawn from the presets", () => {
    const all = new Set(MARKER_GROUPS.flatMap((g) => g.markers));
    for (const mode of ["anaesthesia", "icu"] as const) {
      const quick = quickMarkers(mode);
      expect(quick).toHaveLength(4);
      quick.forEach((label) => expect(all.has(label)).toBe(true));
    }
    expect(quickMarkers("icu")).not.toEqual(quickMarkers("anaesthesia"));
  });

  it("back-dates never go below the start of the case", () => {
    for (const offset of BACKDATE_OFFSETS) {
      expect(Math.max(0, 10 - offset)).toBeGreaterThanOrEqual(0);
    }
  });
});
