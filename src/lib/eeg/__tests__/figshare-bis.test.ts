import { describe, expect, it } from "vitest";

import {
  deriveFigshareSampleRate,
  FIGSHARE_BIS_SAMPLE_RATE,
  figshareBisLineage,
  pairFigshareBisCase,
} from "../figshare-bis";

/** A synthetic 125 Hz trace with a slow rhythm, long enough to replay. */
function trace(seconds: number): Float64Array {
  const n = seconds * FIGSHARE_BIS_SAMPLE_RATE;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FIGSHARE_BIS_SAMPLE_RATE;
    out[i] = 20 * Math.sin(2 * Math.PI * 10 * t) + 8 * Math.sin(2 * Math.PI * 1.5 * t);
  }
  return out;
}

describe("deriveFigshareSampleRate", () => {
  it("accepts the published 625 samples per BIS value", () => {
    expect(deriveFigshareSampleRate(481384, 767)).toBe(125);
  });

  it("rejects a shape that is not a 125 Hz / 5 s recording", () => {
    expect(deriveFigshareSampleRate(481384, 200)).toBeNull();
    expect(deriveFigshareSampleRate(0, 100)).toBeNull();
  });
});

describe("figshareBisLineage", () => {
  it("is its own acquisition lineage, never a Muse or VitalDB one", () => {
    const lineage = figshareBisLineage();
    expect(lineage.deviceId).toBe("figshare-ma-bis");
    expect(lineage.channels).toEqual(["AF7"]);
    expect(lineage.sampleRate).toBe(125);
  });
});

describe("pairFigshareBisCase", () => {
  const seconds = 300;
  const bis = Array.from({ length: (seconds * FIGSHARE_BIS_SAMPLE_RATE) / 625 }, () => 45);

  it("emits one pair per stride with the monitor value attached", () => {
    const paired = pairFigshareBisCase("case1", trace(seconds), bis, { strideSeconds: 30 });
    expect(paired.caseRef).toBe("figshare-case1");
    expect(paired.points.length).toBeGreaterThan(5);
    for (const p of paired.points) {
      expect(p.bis).toBe(45);
      expect(p.appIndex).toBeGreaterThan(0);
      expect(Math.abs(p.lagSeconds)).toBeLessThanOrEqual(2);
      expect(p.externalRef.startsWith("figshare:5589841:case1:")).toBe(true);
    }
    const gaps = paired.points.slice(1).map((p, i) => p.atSeconds - paired.points[i]!.atSeconds);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(30);
  });

  it("rejects out-of-range monitor values instead of pairing them", () => {
    const dirty = bis.map((v, i) => (i % 2 === 0 ? 0 : v));
    const paired = pairFigshareBisCase("case1", trace(seconds), dirty, { strideSeconds: 10 });
    expect(paired.rejected.badRange).toBeGreaterThan(0);
    for (const p of paired.points) expect(p.bis).toBe(45);
  });

  it("refuses a case whose shape contradicts the published cadence", () => {
    expect(() => pairFigshareBisCase("case1", trace(seconds), [45, 45, 45])).toThrow(/125 Hz/);
  });
});
