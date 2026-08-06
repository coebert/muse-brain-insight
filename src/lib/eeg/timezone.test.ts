import { describe, expect, it } from "vitest";
import {
  STORAGE_TIME_ZONE,
  formatRangeInZone,
  formatStampInZone,
  formatTimeInZone,
  isValidTimeZone,
  resolveTimeZone,
  timeZoneOffsetLabel,
} from "./timezone";

const start = "2026-08-06T09:12:00Z";
const end = "2026-08-06T10:46:00Z";

describe("timezone display", () => {
  it("keeps UTC as the storage zone", () => {
    expect(STORAGE_TIME_ZONE).toBe("UTC");
  });

  it("renders the same instant differently per zone without mutating it", () => {
    expect(formatStampInZone(start, "UTC")).toContain("09:12");
    expect(formatStampInZone(start, "Europe/London")).toContain("10:12");
    expect(formatStampInZone(start, "America/New_York")).toContain("05:12");
    expect(start).toBe("2026-08-06T09:12:00Z");
  });

  it("formats ranges and times", () => {
    expect(formatRangeInZone(start, end, "UTC")).toBe("6 Aug 2026, 09:12 – 10:46");
    expect(formatRangeInZone(start, null, "UTC")).toBe("6 Aug 2026, 09:12");
    expect(formatTimeInZone(end, "UTC")).toBe("10:46");
    expect(formatStampInZone(null, "UTC")).toBe("—");
  });

  it("validates and resolves zones", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(resolveTimeZone("Europe/Paris")).toBe("Europe/Paris");
    expect(timeZoneOffsetLabel("UTC", new Date(start))).toBe("UTC+00:00");
    expect(timeZoneOffsetLabel("Europe/London", new Date(start))).toBe("UTC+01:00");
  });
});
