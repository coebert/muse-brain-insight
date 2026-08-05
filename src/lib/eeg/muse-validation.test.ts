import { describe, expect, it } from "vitest";

import {
  DEFAULT_MUSE_PRESET,
  MUSE_PRESETS,
  parseFirmwareVersion,
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

  it("blocks firmware older than the preset-switching minimum", () => {
    const result = validateStreamingConfig(caps({ firmwareVersion: "1.1.9" }), DEFAULT_MUSE_PRESET);
    expect(result.status).toBe("blocked");
    expect(result.issues.some((i) => i.title === "Firmware too old")).toBe(true);
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