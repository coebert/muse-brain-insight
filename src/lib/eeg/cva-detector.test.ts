import { describe, expect, it } from "vitest";

import { detectCva, type CvaEpochInput } from "@/lib/eeg/cva-detector";

const BINS = 60;

/** A flat-ish dB spectrum at a given amplitude, with optional extra slowing. */
function spectrum(level: number, slowing = 0): number[] {
  return Array.from({ length: BINS }, (_, i) => {
    const hz = 0.5 + (i / (BINS - 1)) * 29.5;
    return level + (hz < 4 ? slowing : 0);
  });
}

function epochs(
  count: number,
  build: (i: number, t: number) => Partial<CvaEpochInput>,
): CvaEpochInput[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i * 2;
    return {
      t,
      left: spectrum(10),
      right: spectrum(10),
      leftSqi: 90,
      rightSqi: 90,
      emg: 10,
      ...build(i, t),
    };
  });
}

describe("CVA watch", () => {
  it("says nothing until it has learned the patient's own balance", () => {
    const report = detectCva(epochs(20, () => ({})));
    expect(report.status).toBe("baselining");
    expect(report.finding).toBeNull();
  });

  it("stays quiet when both sides track together", () => {
    const report = detectCva(epochs(200, () => ({})));
    expect(report.status).toBe("stable");
    expect(report.finding).toBeNull();
  });

  it("raises an alert on a sustained one-sided drop with good contact", () => {
    const report = detectCva(
      epochs(200, (_i, t) => (t > 300 ? { left: spectrum(1), right: spectrum(10) } : {})),
    );
    expect(report.status).toBe("alert");
    expect(report.finding?.side).toBe("left");
    expect(report.finding!.powerDropPercent).toBeGreaterThan(40);
  });

  it("does not call a stroke when the side's contact failed at the same time", () => {
    const report = detectCva(
      epochs(200, (_i, t) =>
        t > 300 ? { left: spectrum(1), right: spectrum(10), leftSqi: 10 } : {},
      ),
    );
    expect(report.status).toBe("stable");
    expect(report.excludedBy).toBe("sensor contact");
    expect(report.finding).toBeNull();
  });

  it("does not call a stroke when both sides fall together", () => {
    const report = detectCva(
      epochs(200, (_i, t) => (t > 300 ? { left: spectrum(1), right: spectrum(1) } : {})),
    );
    expect(report.status).toBe("stable");
    expect(report.finding).toBeNull();
  });

  it("reports slowing on the affected side when it is present", () => {
    const report = detectCva(
      epochs(200, (_i, t) =>
        t > 300 ? { left: spectrum(1, 12), right: spectrum(10) } : {},
      ),
    );
    expect(report.finding?.reasons.join(" ")).toContain("delta/alpha");
  });
});
