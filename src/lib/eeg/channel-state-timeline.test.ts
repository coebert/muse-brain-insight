import { describe, expect, it } from "vitest";

import { channelStatePoint, channelStateRuns } from "@/lib/eeg/channel-completeness";
import type { SignalQuality } from "@/lib/eeg/dsp";

function q(grade: SignalQuality["grade"], flat = false, emgIndex = 0.1): SignalQuality {
  return {
    score: grade === "good" ? 0.9 : grade === "fair" ? 0.6 : 0.2,
    grade,
    clipFraction: 0,
    emgIndex,
    jumpRate: 0,
    amplitudeUv: flat ? 0 : 40,
    flat,
    reasons: [],
  };
}

describe("channel state timeline", () => {
  it("maps quality read-outs to coarse states", () => {
    const p = channelStatePoint(10, { TP9: q("good"), AF7: q("poor"), AF8: q("good", true) });
    expect(p.states.TP9).toBe("good");
    expect(p.states.AF7).toBe("poor");
    expect(p.states.AF8).toBe("flat");
    expect(p.states.TP10).toBe("missing");
  });

  it("collapses consecutive samples into runs and captures recovery", () => {
    const history = [
      channelStatePoint(0, { TP9: q("good") }),
      channelStatePoint(2, { TP9: q("good") }),
      channelStatePoint(4, { TP9: q("poor") }),
      channelStatePoint(6, { TP9: q("good") }),
    ];
    const runs = channelStateRuns(history, "TP9", 2);
    expect(runs.map((r) => r.state)).toEqual(["good", "poor", "good"]);
    expect(runs[0]!.endSeconds).toBe(4);
    expect(runs[2]!.startSeconds).toBe(6);
  });

  it("splits a run when samples are not contiguous", () => {
    const history = [channelStatePoint(0, { TP9: q("good") }), channelStatePoint(30, { TP9: q("good") })];
    expect(channelStateRuns(history, "TP9", 2)).toHaveLength(2);
  });
});
