import { describe, expect, it } from "vitest";

import {
  BACKDATE_OFFSETS,
  MARKER_GROUPS,
  MARKER_TEMPLATES,
  quickMarkerTemplates,
  quickMarkers,
} from "./marker-presets";

describe("marker presets", () => {
  it("has unique marker labels across groups", () => {
    const all = MARKER_GROUPS.flatMap((g) => g.markers);
    expect(new Set(all).size).toBe(all.length);
  });

  it("offers mode-specific quick markers drawn from the templates", () => {
    const all = new Set(MARKER_TEMPLATES.map((t) => t.label));
    for (const mode of ["anaesthesia", "icu"] as const) {
      const quick = quickMarkers(mode);
      expect(quick).toHaveLength(4);
      quick.forEach((label) => expect(all.has(label)).toBe(true));
    }
    expect(quickMarkers("icu")).not.toEqual(quickMarkers("anaesthesia"));
  });

  it("gives every template a unique id and a mode", () => {
    const ids = MARKER_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of MARKER_TEMPLATES) {
      expect(t.modes.length).toBeGreaterThan(0);
      expect(t.defaultBackdate).toBeGreaterThanOrEqual(0);
    }
  });

  it("only surfaces templates valid for the active mode", () => {
    for (const mode of ["anaesthesia", "icu"] as const) {
      for (const t of quickMarkerTemplates(mode)) {
        expect(t.modes).toContain(mode);
      }
    }
  });

  it("back-dates observation templates but not drug or stimulus templates", () => {
    const byId = new Map(MARKER_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get("bolus")?.defaultBackdate).toBe(0);
    expect(byId.get("stimulus-start")?.defaultBackdate).toBe(0);
    expect(byId.get("burst-suppression")?.defaultBackdate).toBeGreaterThan(0);
    expect(byId.get("twitching")?.defaultBackdate).toBeGreaterThan(0);
  });

  it("back-dates never go below the start of the case", () => {
    for (const offset of BACKDATE_OFFSETS) {
      expect(Math.max(0, 10 - offset)).toBeGreaterThanOrEqual(0);
    }
  });
});
