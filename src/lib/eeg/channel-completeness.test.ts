import { describe, expect, it } from "vitest";

import {
  accumulateChannelQuality,
  emptyChannelTallies,
  summariseChannelCompleteness,
} from "@/lib/eeg/channel-completeness";
import type { SignalQuality } from "@/lib/eeg/dsp";

function q(grade: SignalQuality["grade"], flat = false, emgIndex = 0.1): SignalQuality {
  return {
    score: grade === "good" ? 0.9 : grade === "fair" ? 0.6 : 0.2,
    grade,
    clipFraction: 0,
    emgIndex,
    jumpRate: 0,
    amplitudeUv: 40,
    flat,
    reasons: [],
    dropoutFraction: 0,
  } as SignalQuality;
}

describe("channel completeness", () => {
  it("starts empty and reports no data", () => {
    const rows = summariseChannelCompleteness(emptyChannelTallies(), 1);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.epochs === 0 && r.note === "No data yet")).toBe(true);
  });

  it("rates a clean electrode as ok and a flat one as poor", () => {
    const t = emptyChannelTallies();
    for (let i = 0; i < 10; i++) {
      accumulateChannelQuality(t, { TP9: q("good"), AF7: q("poor", true), AF8: q("good"), TP10: q("good") });
    }
    const rows = summariseChannelCompleteness(t, 1);
    const tp9 = rows.find((r) => r.channel === "TP9")!;
    const af7 = rows.find((r) => r.channel === "AF7")!;
    expect(tp9.level).toBe("ok");
    expect(tp9.usableFraction).toBe(1);
    expect(af7.level).toBe("poor");
    expect(af7.flatFraction).toBe(1);
    expect(af7.side).toBe("left");
    expect(af7.missingSeconds).toBe(10);
  });

  it("tracks the longest unusable run in seconds", () => {
    const t = emptyChannelTallies();
    const seq: SignalQuality["grade"][] = ["good", "poor", "poor", "poor", "good", "poor"];
    for (const g of seq) accumulateChannelQuality(t, { TP10: q(g) });
    const tp10 = summariseChannelCompleteness(t, 2).find((r) => r.channel === "TP10")!;
    expect(tp10.worstRunSeconds).toBe(6);
    expect(tp10.poorFraction).toBeCloseTo(4 / 6, 5);
  });

  it("flags sustained muscle contamination", () => {
    const t = emptyChannelTallies();
    for (let i = 0; i < 5; i++) accumulateChannelQuality(t, { AF8: q("good", false, 0.7) });
    const af8 = summariseChannelCompleteness(t, 1).find((r) => r.channel === "AF8")!;
    expect(af8.meanEmg).toBeCloseTo(0.7, 5);
    expect(af8.note).toBe("High muscle contamination");
  });
});
