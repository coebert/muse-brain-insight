import { describe, expect, it } from "vitest";

import { SidePreference, type SideQuality } from "./side-preference";

const good: SideQuality = { score: 0.9, flat: false, grade: "good" };
const poor: SideQuality = { score: 0.3, flat: false, grade: "poor" };
const flat: SideQuality = { score: 0.6, flat: true, grade: "fair" };
const fair: SideQuality = { score: 0.78, flat: false, grade: "fair" };

describe("SidePreference", () => {
  it("uses both sides when quality is comparable", () => {
    const p = new SidePreference();
    for (let i = 0; i < 10; i++) expect(p.update(good, fair).side).toBeNull();
  });

  it("hands over to the clean side only after a sustained advantage", () => {
    const p = new SidePreference();
    expect(p.update(good, poor).side).toBeNull();
    expect(p.update(good, poor).side).toBeNull();
    expect(p.update(good, poor).side).toBe("left");
  });

  it("prefers the side opposite a disconnected electrode pair", () => {
    const p = new SidePreference();
    let side = null;
    for (let i = 0; i < 4; i++) side = p.update(flat, good).side;
    expect(side).toBe("right");
  });

  it("returns to both sides once quality converges", () => {
    const p = new SidePreference();
    for (let i = 0; i < 4; i++) p.update(good, poor);
    expect(p.update(good, good).side).toBeNull();
  });

  it("does not flap on brief single-epoch dips", () => {
    const p = new SidePreference();
    p.update(good, poor);
    p.update(good, good);
    p.update(good, poor);
    expect(p.update(good, good).side).toBeNull();
  });

  it("reset clears the held side", () => {
    const p = new SidePreference();
    for (let i = 0; i < 4; i++) p.update(good, poor);
    p.reset();
    expect(p.update(good, poor).side).toBeNull();
  });
});
