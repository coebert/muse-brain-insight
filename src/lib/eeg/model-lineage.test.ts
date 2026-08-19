import { describe, expect, it } from "vitest";

import { DEVICE_PROFILES, MUSE_2_PROFILE, deviceProfileById } from "./device-profile";
import {
  applySeizureGate,
  compareLineage,
  gateCoebisModel,
  gateSeizureDetector,
  lineageFromProfile,
  lineageKey,
  parseLineageKey,
  selectTrainingForLineage,
  summariseLineages,
} from "./model-lineage";

const muse = lineageFromProfile(MUSE_2_PROFILE);
const single = lineageFromProfile(
  deviceProfileById("focuscalm") ?? DEVICE_PROFILES[DEVICE_PROFILES.length - 1]!,
);

describe("lineage keys", () => {
  it("round-trips through a key", () => {
    const parsed = parseLineageKey(lineageKey(muse));
    expect(parsed?.deviceId).toBe(muse.deviceId);
    expect(parsed?.channels).toEqual(muse.channels);
  });

  it("treats an unparseable key as unknown", () => {
    expect(parseLineageKey("")).toBeNull();
  });
});

describe("compareLineage", () => {
  it("matches a setup against itself", () => {
    expect(compareLineage(muse, muse).match).toBe("exact");
  });

  it("does not treat a single frontal channel as equivalent to a full montage", () => {
    expect(["reduced", "incompatible"]).toContain(compareLineage(muse, single).match);
  });
});

describe("gating", () => {
  it("lets a model run on the setup it was fitted on", () => {
    expect(gateCoebisModel(muse, muse).mode).toBe("run");
  });

  it("holds a model back on a setup it has no evidence for", () => {
    expect(gateCoebisModel(muse, single).mode).not.toBe("run");
  });

  it("keeps validated seizure thresholds on the full montage", () => {
    const gate = gateSeizureDetector(MUSE_2_PROFILE);
    const settings = { seizureScoreThreshold: 0.5, seizureMinEpochs: 2 };
    expect(applySeizureGate(settings, gate)).toEqual(settings);
  });

  it("stiffens or blocks the detector on a reduced montage", () => {
    const profile = deviceProfileById("focuscalm");
    if (!profile) return;
    const gate = gateSeizureDetector(profile);
    const gated = applySeizureGate({ seizureScoreThreshold: 0.5, seizureMinEpochs: 2 }, gate);
    expect(
      gate.mode === "blocked" ||
        gated.seizureScoreThreshold > 0.5 ||
        gated.seizureMinEpochs > 2,
    ).toBe(true);
  });
});

describe("training selection", () => {
  const points = [
    { lineageKey: lineageKey(muse), v: 1 },
    { lineageKey: lineageKey(single), v: 2 },
    { lineageKey: null, v: 3 },
  ];

  it("keeps same-setup readings and drops ones that cannot transfer", () => {
    const sel = selectTrainingForLineage(points, muse);
    expect(sel.used.some((p) => p.v === 1)).toBe(true);
    // Unlabelled historic readings are kept rather than discarding early data.
    expect(sel.unlabelled).toHaveLength(1);
    for (const p of sel.excluded) {
      expect(compareLineage(parseLineageKey(p.lineageKey!), muse).match).toBe("incompatible");
    }
  });

  it("reports a mixed training set", () => {
    expect(summariseLineages(points).mixed).toBe(true);
  });
});
