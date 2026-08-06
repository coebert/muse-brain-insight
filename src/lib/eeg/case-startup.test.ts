import { beforeEach, describe, expect, it } from "vitest";

import { generateCaseCode, loadCaseStartup, nextCaseCode, saveCaseStartup } from "./case-startup";

describe("case start-up memory", () => {
  beforeEach(() => window.localStorage.clear());

  it("increments a trailing sequence, preserving zero padding", () => {
    expect(nextCaseCode("ICU-007")).toBe("ICU-008");
    expect(nextCaseCode("ICU-099")).toBe("ICU-100");
    expect(nextCaseCode("THEATRE")).toBe("THEATRE-2");
    expect(nextCaseCode("  ")).toBe("");
  });

  it("round-trips context, location and mode for the next case", () => {
    saveCaseStartup({
      context: "icu_sedation",
      location: "ICU bed 4",
      lastCaseCode: "ICU-007",
      mode: "icu",
    });
    expect(loadCaseStartup()).toEqual({
      context: "icu_sedation",
      location: "ICU bed 4",
      lastCaseCode: "ICU-007",
      mode: "icu",
    });
  });

  it("returns null when nothing has been stored", () => {
    expect(loadCaseStartup()).toBeNull();
  });
});

describe("generateCaseCode", () => {
  const at = new Date(2026, 7, 6, 9, 30);

  it("builds a context-prefixed, dated, random code with no identifiers", () => {
    expect(generateCaseCode("general_anaesthesia", at, () => 0)).toBe("GA-260806-AAAA");
    expect(generateCaseCode("icu_sedation", at, () => 0)).toBe("ICU-260806-AAAA");
    expect(generateCaseCode("procedural_sedation", at, () => 0)).toBe("PS-260806-AAAA");
    expect(generateCaseCode("nonsense", at, () => 0)).toBe("CT-260806-AAAA");
  });

  it("avoids ambiguous characters and stays unique across calls", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateCaseCode("icu_sedation", at)));
    expect(codes.size).toBeGreaterThan(150);
    for (const code of codes) {
      expect(code).toMatch(/^ICU-260806-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });
});
