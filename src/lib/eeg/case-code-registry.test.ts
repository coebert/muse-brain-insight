import { describe, expect, it } from "vitest";
import { generateUniqueCaseCode, isCaseCodeUsed } from "./case-code-registry";

describe("case code registry", () => {
  it("matches codes case-insensitively and ignoring whitespace", () => {
    expect(isCaseCodeUsed(" ga-260806-k7qf ", ["GA-260806-K7QF"])).toBe(true);
    expect(isCaseCodeUsed("GA-260806-AAAA", ["GA-260806-K7QF"])).toBe(false);
    expect(isCaseCodeUsed("  ", ["GA-260806-K7QF"])).toBe(false);
  });

  it("re-rolls until a code is free and reports the collision", () => {
    const codes = ["GA-1", "GA-1", "GA-2"];
    let i = 0;
    const result = generateUniqueCaseCode(["GA-1"], () => codes[i++]!);
    expect(result.code).toBe("GA-2");
    expect(result.collisions).toBe(2);
    expect(result.unique).toBe(true);
  });

  it("flags when every attempt collided", () => {
    const result = generateUniqueCaseCode(["GA-1"], () => "GA-1", 3);
    expect(result.unique).toBe(false);
  });
});
