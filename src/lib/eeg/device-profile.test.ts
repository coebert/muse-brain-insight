import { describe, expect, it } from "vitest";

import {
  ANALYSIS_CHANNELS,
  FOCUSCALM_PROFILE,
  FRONTAL_PAIR_PROFILE,
  MUSE_2_PROFILE,
  channelLabel,
  channelPairs,
  describeDeviceProfile,
  hemisphereChannels,
  isBilateral,
  profileFromChannelMap,
} from "@/lib/eeg/device-profile";

describe("device profiles", () => {
  it("groups the full montage by hemisphere", () => {
    expect(hemisphereChannels(MUSE_2_PROFILE, "left")).toEqual(["TP9", "AF7"]);
    expect(hemisphereChannels(MUSE_2_PROFILE, "right")).toEqual(["AF8", "TP10"]);
    expect(isBilateral(MUSE_2_PROFILE)).toBe(true);
  });

  it("reports a single-channel device as unilateral", () => {
    expect(isBilateral(FOCUSCALM_PROFILE)).toBe(false);
    expect(hemisphereChannels(FOCUSCALM_PROFILE, "right")).toEqual([]);
    const described = describeDeviceProfile(FOCUSCALM_PROFILE);
    expect(described.channelCount).toBe(1);
    expect(described.missing).toHaveLength(3);
    expect(described.limitations.join(" ")).toMatch(/Unilateral/);
  });

  it("warns when the device samples below the analysis rate", () => {
    expect(describeDeviceProfile(FOCUSCALM_PROFILE).limitations.join(" ")).toMatch(/250 Hz/);
    expect(describeDeviceProfile(FRONTAL_PAIR_PROFILE).limitations.join(" ")).not.toMatch(/Hz and is upsampled/);
  });

  it("pairs channels for the paired FFT, leaving an odd channel alone", () => {
    expect(channelPairs(MUSE_2_PROFILE)).toEqual([
      ["TP9", "AF7"],
      ["AF8", "TP10"],
    ]);
    expect(channelPairs(FOCUSCALM_PROFILE)).toEqual([["AF7", null]]);
  });

  it("shows the device's own electrode name when it differs", () => {
    expect(channelLabel(FOCUSCALM_PROFILE, "AF7")).toBe("AF7 (Fp1–Fp2)");
    expect(channelLabel(MUSE_2_PROFILE, "AF7")).toBe("AF7");
  });

  it("builds a profile from a channel mapping", () => {
    const p = profileFromChannelMap({
      label: "Amplifier export",
      sampleRate: 500,
      map: { AF7: "Fp1", AF8: "Fp2", TP9: null, TP10: null },
    });
    expect(p.channels).toEqual(["AF7", "AF8"]);
    expect(p.sourceLabels.AF7).toBe("Fp1");
    expect(isBilateral(p)).toBe(true);
    expect(p.note).toMatch(/2 of 4/);
  });

  it("calls a complete mapping full", () => {
    const map = Object.fromEntries(ANALYSIS_CHANNELS.map((c) => [c, c]));
    const p = profileFromChannelMap({ label: "x", sampleRate: 256, map });
    expect(describeDeviceProfile(p).limitations).toEqual([]);
    expect(p.note).toMatch(/Full four-electrode/);
  });
});
