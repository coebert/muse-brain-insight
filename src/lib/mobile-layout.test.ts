import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Mobile bedside guardrails. These are source-level checks so a regression is
 * caught in CI rather than at 03:00 on a phone in theatre.
 */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const files = sourceFiles();

describe("mobile layout guardrails", () => {
  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("keeps every literal font size at 11px or above", () => {
    const offenders = files.filter((f) => /text-\[(?:[0-9]|10)px\]/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("uses dynamic viewport height so mobile browser chrome cannot clip layouts", () => {
    const offenders = files.filter((f) => /\b(?:min-)?h-screen\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("never fixes a width in pixels wider than a small phone viewport", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(/\bw-\[(\d+)px\]/g)) {
        if (Number(match[1]) > 320) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
