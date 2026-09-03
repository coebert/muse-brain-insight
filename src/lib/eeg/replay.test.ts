import { describe, expect, it } from "vitest";

import { covariateBreakdown, replayRawEeg, type ReplayFrame } from "./replay";

function sine(seconds: number, fs: number, hz: number, amp: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < seconds * fs; i++) out.push(amp * Math.sin((2 * Math.PI * hz * i) / fs));
  return out;
}

describe("replayRawEeg", () => {
  const fs = 128;

  it("produces one frame per second with DSA features", () => {
    const samples = sine(30, fs, 10, 20);
    const r = replayRawEeg({ samples, sampleRate: fs });
    expect(r.frames.length).toBeGreaterThan(20);
    const f = r.frames[0]!;
    expect(f.spectrum.length).toBeGreaterThan(10);
    expect(f.sef95).toBeGreaterThan(0);
    expect(f.suppressionRatio).toBeGreaterThanOrEqual(0);
    // Frames sit on a 1 s grid.
    expect(r.frames[1]!.t - r.frames[0]!.t).toBe(1);
  });

  it("flags a flat recording as suppressed", () => {
    const samples = new Array(30 * fs).fill(0);
    const r = replayRawEeg({ samples, sampleRate: fs });
    expect(r.frames.every((f) => f.isSuppressed)).toBe(true);
  });

  it("scores COEBIS against supplied monitor readings", () => {
    const samples = sine(60, fs, 10, 20);
    const bis = Array.from({ length: 12 }, (_, i) => ({ t: i * 5 + 5, v: 45 }));
    const r = replayRawEeg({
      samples,
      sampleRate: fs,
      bis,
      alignment: { gain: 1, offset: 0, n: 10, fittedAt: "", family: "affine" },
      toleranceSeconds: 5,
    });
    expect(r.pairs.length).toBeGreaterThan(0);
    expect(r.metrics?.n).toBe(r.pairs.length);
    expect(r.notes).not.toContain("No monitor readings in the file, so agreement cannot be scored.");
  });

  it("notes a missing model and missing monitor data", () => {
    const r = replayRawEeg({ samples: sine(10, fs, 10, 20), sampleRate: fs });
    expect(r.notes.length).toBe(2);
  });

  it("returns nothing usable for a recording shorter than one window", () => {
    const r = replayRawEeg({ samples: sine(1, fs, 10, 20), sampleRate: fs });
    expect(r.frames).toEqual([]);
  });
});

describe("covariateBreakdown", () => {
  const frames: ReplayFrame[] = [1, 2, 3].map((t) => ({
    t,
    spectrum: [1, 2, 3],
    totalPower: 10,
    sef95: 12,
    suppressionRatio: 0,
    isSuppressed: false,
    appIndex: 50,
    coebis: 48,
    bis: 44,
  }));

  it("pairs each case covariate with the external prior", () => {
    const rows = covariateBreakdown(frames, { ageBand: "60-74", sex: "male" }, [
      { group: "age", level: "60-74", n: 300, cases: 3, meanBis: 42.5, meanPropofolCe: 2.8 },
    ]);
    expect(rows).toHaveLength(2);
    const age = rows.find((r) => r.group === "age")!;
    expect(age.meanCoebis).toBe(48);
    expect(age.meanBis).toBe(44);
    expect(age.bias).toBe(4);
    expect(age.priorBis).toBe(42.5);
    expect(age.priorCases).toBe(3);
    expect(rows.find((r) => r.group === "sex")!.priorBis).toBeNull();
  });

  it("is empty when no covariates are known", () => {
    expect(covariateBreakdown(frames, null, [])).toEqual([]);
  });
});
