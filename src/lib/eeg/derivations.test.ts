import { describe, expect, it } from "vitest";

import { deriveClinical, suppressionTone } from "@/lib/eeg/derivations";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";

function epoch(t: number, over: Partial<Record<string, unknown>> = {}): Epoch {
  return {
    t,
    sef95: 12,
    epochSuppression: 0,
    suppressionRatio: 0,
    seizureScore: 0.1,
    seizureAlert: false,
    artifact: false,
    amplitudeUv: 40,
    bands: { delta: 4, theta: 2, alpha: 2, beta: 1, gamma: 1 },
    quality: { score: 0.9, emgIndex: 0.05, grade: "good" },
    confidence: { spectral: 0.9, suppression: 0.9, seizure: 0.9, depth: 0.9 },
    depth: { index: 45, state: "general", held: false, heldSeconds: 0, gateReasons: [] },
    depthReliability: { reliable: true, level: "ok", reasons: [] },
    ...over,
  } as unknown as Epoch;
}

const SETTINGS = { srWindowSeconds: 60, seizureThreshold: 0.6, bsrAlertPercent: 10 };

const base = {
  hemi: null,
  settings: SETTINGS,
  icuMode: false,
  dataGapSeconds: 0,
  reconnecting: false,
};

describe("suppressionTone", () => {
  it("escalates with the suppression ratio", () => {
    expect(suppressionTone(null)).toBe("default");
    expect(suppressionTone(2)).toBe("signal");
    expect(suppressionTone(15)).toBe("caution");
    expect(suppressionTone(55)).toBe("critical");
  });
});

describe("deriveClinical", () => {
  it("merges detector events and clinician markers in time order", () => {
    const events: DetectedEvent[] = [
      { kind: "seizure", severity: "warning", t: 30, duration: 0, detail: "rhythmic" },
    ];
    const markers: DetectedEvent[] = [
      { kind: "annotation", severity: "info", t: 10, duration: 0, detail: "ketamine bolus" },
    ];
    const d = deriveClinical({ ...base, epochs: [epoch(0), epoch(1)], events, markers });
    expect(d.allEvents.map((e) => e.t)).toEqual([10, 30]);
    expect(d.dsaMarkers.some((m) => m.label === "ketamine bolus")).toBe(true);
  });

  it("exposes one live picture shared by tiles, alarms and AI panels", () => {
    const latest = epoch(2, {
      suppressionRatio: 46,
      seizureAlert: true,
      seizureScore: 0.82,
    });
    const d = deriveClinical({ ...base, epochs: [epoch(0), latest], events: [], markers: [] });
    expect(d.latest).toBe(latest);
    expect(d.seizureAlert).toBe(true);
    expect(d.srTone).toBe("critical");
    expect(d.live.suppressionRatio).toBe(46);
    expect(d.live.sqi).toBe(90);
    expect(d.alarmConditions.some((c) => c.id.startsWith("seizure"))).toBe(true);
    expect(d.uncertainty.suppression.interval).toBeDefined();
  });

  it("returns an empty picture with no epochs", () => {
    const d = deriveClinical({ ...base, epochs: [], events: [], markers: [] });
    expect(d.latest).toBeNull();
    expect(d.live.depthIndex).toBeNull();
    expect(d.srTone).toBe("default");
  });
});
