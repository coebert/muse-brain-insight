import { describe, expect, it } from "vitest";

import {
  DEFAULT_MUSE_PRESET,
  MUSE_PRESETS,
  parseFirmwareVersion,
  selectBestPreset,
  validateStreamingConfig,
  type MuseCapabilities,
} from "./muse";

function caps(overrides: Partial<MuseCapabilities> = {}): MuseCapabilities {
  return {
    deviceName: "Muse-1234",
    model: "Muse 2",
    firmwareVersion: "1.2.13",
    hardwareVersion: "2.0",
    buildNumber: "20",
    protocolVersion: "2",
    batteryPercent: 88,
    presets: MUSE_PRESETS.filter((p) => !p.requiresMuseS),
    recommendedPreset: DEFAULT_MUSE_PRESET,
    raw: {},
    ...overrides,
  };
}

describe("parseFirmwareVersion", () => {
  it("reads dotted versions and tolerates prefixes", () => {
    expect(parseFirmwareVersion("1.2.13")).toEqual([1, 2, 13]);
    expect(parseFirmwareVersion("fw 3.1")).toEqual([3, 1, 0]);
    expect(parseFirmwareVersion(null)).toBeNull();
    expect(parseFirmwareVersion("unknown")).toBeNull();
  });
});

describe("validateStreamingConfig", () => {
  it("passes a healthy Muse 2 on the recommended preset", () => {
    const result = validateStreamingConfig(caps(), DEFAULT_MUSE_PRESET);
    expect(result.status).toBe("ok");
    expect(result.issues).toHaveLength(0);
  });

  it("blocks an unrecognised preset and suggests the default", () => {
    const result = validateStreamingConfig(caps(), "p99");
    expect(result.status).toBe("blocked");
    expect(result.issues[0]?.suggestedPreset).toBe(DEFAULT_MUSE_PRESET);
  });

  it("blocks a Muse S preset on Muse 2 hardware", () => {
    const result = validateStreamingConfig(caps(), "p50");
    expect(result.status).toBe("blocked");
    expect(result.issues.some((i) => /Muse S/.test(i.title))).toBe(true);
  });

  it("allows the Muse S preset when the headband is a Muse S", () => {
    const result = validateStreamingConfig(
      caps({ model: "Muse S", presets: MUSE_PRESETS }),
      "p50",
    );
    expect(result.status).toBe("ok");
  });

  it("does not block a current headband on an older firmware family", () => {
    const result = validateStreamingConfig(caps({ firmwareVersion: "1.1.9" }), DEFAULT_MUSE_PRESET);
    expect(result.status).toBe("ok");
  });

  it("warns, without blocking, on pre-release firmware", () => {
    const result = validateStreamingConfig(caps({ firmwareVersion: "0.9.1" }), DEFAULT_MUSE_PRESET);
    expect(result.status).toBe("warning");
    expect(result.issues.some((i) => i.title === "Unusually old firmware")).toBe(true);
  });

  it("warns rather than blocks when firmware is not reported", () => {
    const result = validateStreamingConfig(
      caps({ firmwareVersion: null, buildNumber: null }),
      DEFAULT_MUSE_PRESET,
    );
    expect(result.status).toBe("warning");
    expect(result.issues[0]?.fix).toMatch(/Re-read/);
  });

  it("warns on a low battery and blocks a nearly flat one", () => {
    expect(validateStreamingConfig(caps({ batteryPercent: 15 }), DEFAULT_MUSE_PRESET).status).toBe(
      "warning",
    );
    expect(validateStreamingConfig(caps({ batteryPercent: 6 }), DEFAULT_MUSE_PRESET).status).toBe(
      "blocked",
    );
  });

  it("blocks a preset the headband did not report support for", () => {
    const result = validateStreamingConfig(
      caps({ presets: MUSE_PRESETS.filter((p) => p.code === "p21") }),
      "p20",
    );
    expect(result.status).toBe("blocked");
    expect(result.issues[0]?.title).toMatch(/not supported/i);
  });
});
describe("selectBestPreset", () => {
  it("keeps the recommended mode when it is compatible", () => {
    const best = selectBestPreset(caps());
    expect(best.preset).toBe(DEFAULT_MUSE_PRESET);
    expect(best.deviceBlocked).toBe(false);
    expect(best.validation.status).toBe("ok");
  });

  it("falls back to a compatible mode when the recommended one is unsupported", () => {
    const best = selectBestPreset(
      caps({
        recommendedPreset: "p50",
        presets: MUSE_PRESETS.filter((p) => p.code === "p20" || p.code === "p50"),
      }),
    );
    expect(best.preset).toBe("p20");
    expect(best.deviceBlocked).toBe(false);
  });

  it("reports a device-level block when no mode can clear validation", () => {
    const best = selectBestPreset(caps({ batteryPercent: 4 }));
    expect(best.deviceBlocked).toBe(true);
    expect(best.validation.status).toBe("blocked");
  });
});
