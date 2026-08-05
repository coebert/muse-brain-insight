import { beforeEach, describe, expect, it } from "vitest";

import { loadCaseStartup, nextCaseCode, saveCaseStartup } from "./case-startup";

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
