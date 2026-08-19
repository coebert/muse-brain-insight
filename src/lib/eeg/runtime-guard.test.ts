import { describe, expect, it } from "vitest";

import { guardCoebisRuntime, guardSeizureRuntime } from "./runtime-guard";
import { lineageKey, lineageFromProfile } from "./model-lineage";
import { DEVICE_PROFILES, getActiveDeviceProfile } from "./device-profile";

const muse = DEVICE_PROFILES["muse-2"] ?? getActiveDeviceProfile();

const goodThresholds = {
  seizureThreshold: 0.6,
  seizureEpochs: 3,
  suppressionThresholdUv: 5,
  srWindowSeconds: 60,
};

describe("guardSeizureRuntime", () => {
  it("clears a valid config on the validated montage", () => {
    const r = guardSeizureRuntime(goodThresholds, { profile: muse });
    expect(r.status).toBe("ok");
    expect(r.thresholds?.seizureThreshold).toBe(0.6);
  });

  it("blocks when the threshold shape is unusable", () => {
    const r = guardSeizureRuntime({ ...goodThresholds, seizureThreshold: 9 }, { profile: muse });
    expect(r.status).toBe("blocked");
    expect(r.thresholds).toBeNull();
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it("warns and migrates legacy field names", () => {
    const { seizureThreshold, ...rest } = goodThresholds;
    const r = guardSeizureRuntime({ ...rest, seizureScoreThreshold: seizureThreshold }, {
      profile: muse,
    });
    expect(r.status).toBe("warn");
    expect(r.thresholds?.seizureThreshold).toBe(0.6);
    expect(r.warnings.join(" ")).toContain("seizureThreshold");
  });
});

describe("guardCoebisRuntime", () => {
  const model = {
    modelVersion: "v1",
    modelFamily: "affine" as const,
    lineageKey: lineageKey(lineageFromProfile(muse)),
    gain: 1,
    offset: 0,
  };

  it("clears a model fitted on the same setup", () => {
    expect(guardCoebisRuntime(model, { profile: muse }).status).toBe("ok");
  });

  it("blocks a model whose schema is wrong", () => {
    const r = guardCoebisRuntime({ ...model, modelFamily: "covariate" }, { profile: muse });
    expect(r.status).toBe("blocked");
  });

  it("warns when no model is stored", () => {
    expect(guardCoebisRuntime(null, { profile: muse }).status).toBe("warn");
  });
});
