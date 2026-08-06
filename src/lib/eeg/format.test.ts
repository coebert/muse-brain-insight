import { describe, expect, it } from "vitest";
import { caseDurationSeconds, formatCaseDuration } from "./format";

describe("case duration", () => {
  it("computes end minus start", () => {
    expect(caseDurationSeconds("2026-08-06T09:12:00Z", "2026-08-06T10:46:00Z")).toBe(94 * 60);
  });
  it("returns null without an end", () => {
    expect(caseDurationSeconds("2026-08-06T09:12:00Z", null)).toBeNull();
  });
  it("formats hours and minutes", () => {
    expect(formatCaseDuration("2026-08-06T09:12:00Z", "2026-08-06T10:46:00Z")).toBe("1 h 34 min");
    expect(formatCaseDuration("2026-08-06T09:12:00Z", "2026-08-06T09:24:00Z")).toBe("12 min");
    expect(formatCaseDuration(null, null)).toBe("—");
  });
});
