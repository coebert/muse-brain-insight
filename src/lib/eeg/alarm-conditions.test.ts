import { describe, expect, it } from "vitest";

import { deriveAlarmConditions } from "./alarm-conditions";
import type { HemiLatest, HemiMetrics } from "@/hooks/useEegMonitor";

function hemi(overrides: Partial<HemiMetrics> = {}): HemiMetrics {
  return {
    suppressionRatio: 0,
    seizureScore: 0,
    seizureAlert: false,
    qualityGrade: "good",
    flat: false,
    qualityScore: 0.9,
    spectralConfidence: 0.9,
    emgIndex: 0.05,
    reasons: [],
    ...overrides,
  };
}

function sides(left: Partial<HemiMetrics>, right: Partial<HemiMetrics> = {}): HemiLatest {
  return { left: hemi(left), right: hemi(right) };
}

const base = {
  latest: null,
  hemi: null,
  icuMode: false,
  bsrAlertPercent: 10,
  dataGapSeconds: 0,
  reconnecting: false,
};

describe("deriveAlarmConditions", () => {
  it("is quiet with no data", () => {
    expect(deriveAlarmConditions(base)).toEqual([]);
  });

  it("attributes a unilateral seizure to that side", () => {
    const out = deriveAlarmConditions({
      ...base,
      hemi: sides({ seizureAlert: true, seizureScore: 0.8 }),
    });
    expect(out.map((c) => c.id)).toEqual(["seizure:left"]);
    expect(out[0]!.side).toBe("left");
    expect(out[0]!.priority).toBe("medium");
  });

  it("escalates seizure priority in ICU mode and merges bilateral alerts", () => {
    const out = deriveAlarmConditions({
      ...base,
      icuMode: true,
      hemi: sides({ seizureAlert: true }, { seizureAlert: true }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("seizure:bilateral");
    expect(out[0]!.priority).toBe("high");
  });

  it("raises deep suppression above the clinician threshold", () => {
    const out = deriveAlarmConditions({
      ...base,
      hemi: sides({ suppressionRatio: 55 }, { suppressionRatio: 15 }),
    });
    expect(out.map((c) => c.id)).toEqual(["deep-suppression:left", "suppression:right"]);
    expect(out[0]!.priority).toBe("high");
  });

  it("reports a whole-headband dropout as bilateral signal loss", () => {
    const out = deriveAlarmConditions({ ...base, dataGapSeconds: 8, hemi: sides({}) });
    expect(out.map((c) => c.id)).toEqual(["signal-loss:bilateral"]);
  });

  it("reports a flat electrode pair as one-sided signal loss", () => {
    const out = deriveAlarmConditions({ ...base, hemi: sides({ flat: true }) });
    expect(out.map((c) => c.id)).toEqual(["signal-loss:left"]);
  });

  it("names the reconnect attempt while reconnecting", () => {
    const out = deriveAlarmConditions({
      ...base,
      reconnecting: true,
      reconnectAttempt: { attempt: 2, attempts: 5 },
    });
    expect(out[0]!.detail).toContain("attempt 2 of 5");
  });
});