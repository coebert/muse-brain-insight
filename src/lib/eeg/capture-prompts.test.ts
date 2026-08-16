import { describe, expect, it } from "vitest";

import { evaluateCapturePrompt, PROMPT_QUIET_SECONDS } from "./capture-prompts";

const base = {
  running: true,
  elapsed: 300,
  depthIndex: 45,
  suppressionRatio: 0,
  trend: [] as { t: number; index: number | null }[],
  lastReadingAt: null as number | null,
  readings: 0,
};

describe("capture prompts", () => {
  it("stays quiet when no case is running", () => {
    expect(evaluateCapturePrompt({ ...base, running: false })).toBeNull();
  });

  it("asks for an induction reading before any have been logged", () => {
    expect(evaluateCapturePrompt(base)?.kind).toBe("induction");
  });

  it("stays quiet just after a reading", () => {
    expect(
      evaluateCapturePrompt({ ...base, readings: 1, lastReadingAt: 300 - PROMPT_QUIET_SECONDS + 10 }),
    ).toBeNull();
  });

  it("prioritises burst suppression over induction", () => {
    expect(evaluateCapturePrompt({ ...base, suppressionRatio: 12 })?.kind).toBe("suppression");
  });

  it("spots emergence when the index climbs sharply", () => {
    const prompt = evaluateCapturePrompt({
      ...base,
      elapsed: 3600,
      readings: 2,
      lastReadingAt: 1200,
      depthIndex: 75,
      trend: [
        { t: 3300, index: 40 },
        { t: 3400, index: 45 },
      ],
    });
    expect(prompt?.kind).toBe("emergence");
  });

  it("falls back to a steady-state top-up after fifteen quiet minutes", () => {
    const prompt = evaluateCapturePrompt({
      ...base,
      elapsed: 2000,
      readings: 3,
      lastReadingAt: 1000,
    });
    expect(prompt?.kind).toBe("steady");
  });
});
