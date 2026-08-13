import { describe, expect, it } from "vitest";

import { assessBatteryHealth, type BatteryReading } from "./battery-health";

const series = (values: [number, number][]): BatteryReading[] =>
  values.map(([seconds, percent]) => ({ t: 1_000_000 + seconds * 1000, percent }));

describe("assessBatteryHealth", () => {
  it("reports unknown before any reading", () => {
    expect(assessBatteryHealth([]).status).toBe("unknown");
  });

  it("accepts a normal discharge curve", () => {
    const health = assessBatteryHealth(series([[0, 84], [60, 83], [120, 82], [600, 78]]));
    expect(health.status).toBe("ok");
    expect(health.trusted).toBe(78);
  });

  it("flags an impossible cliff and keeps the last plausible value", () => {
    const health = assessBatteryHealth(series([[0, 80], [60, 79], [90, 12]]));
    expect(health.status).toBe("suspect");
    expect(health.trusted).toBe(79);
  });

  it("flags a rise that is not a charge", () => {
    expect(assessBatteryHealth(series([[0, 40], [60, 72]])).status).toBe("suspect");
  });

  it("calls repeated nonsense unreliable", () => {
    const health = assessBatteryHealth(series([[0, 80], [60, 9], [120, 81], [180, 80]]));
    expect(health.status).toBe("unreliable");
    expect(health.anomalies).toBeGreaterThanOrEqual(2);
  });

  it("rejects out-of-range values", () => {
    const health = assessBatteryHealth(series([[0, 55], [60, 240]]));
    expect(health.anomalies).toBe(1);
    expect(health.trusted).toBe(55);
  });

  it("tolerates a slow drop over a long interval", () => {
    expect(assessBatteryHealth(series([[0, 90], [3600, 55]])).status).toBe("ok");
  });
});
