import { describe, expect, it } from "vitest";

import { FOCUSCALM_PROFILE, MUSE_2_PROFILE } from "./device-profile";
import { deviceTuning, resolveDsaView } from "./device-tuning";

describe("device tuning", () => {
  it("gives the Muse 2 the full bilateral, calibrated configuration", () => {
    const t = deviceTuning(MUSE_2_PROFILE);
    expect(t.dsaViews).toEqual(["bilateral", "combined", "overlay"]);
    expect(t.defaultDsaView).toBe("bilateral");
    expect(t.absoluteAmplitude).toBe(true);
    expect(t.emgBandAvailable).toBe(true);
    expect(t.showBattery).toBe(true);
    expect(t.autoReconnect).toBe(true);
    expect(t.stiffenedSeizureGating).toBe(false);
    expect(t.caveats).toHaveLength(0);
  });

  it("collapses FocusCalm to one lane and flags its uncalibrated amplitude", () => {
    const t = deviceTuning(FOCUSCALM_PROFILE);
    expect(t.dsaViews).toEqual(["combined"]);
    expect(t.defaultDsaView).toBe("combined");
    expect(t.absoluteAmplitude).toBe(false);
    expect(t.stiffenedSeizureGating).toBe(true);
    expect(t.autoReconnect).toBe(false);
    expect(t.caveats.join(" ")).toMatch(/auto-gained/);
  });

  it("clamps a stored bilateral preference on a unilateral montage", () => {
    expect(resolveDsaView(deviceTuning(FOCUSCALM_PROFILE), "bilateral")).toBe("combined");
    expect(resolveDsaView(deviceTuning(MUSE_2_PROFILE), "overlay")).toBe("overlay");
  });
});
