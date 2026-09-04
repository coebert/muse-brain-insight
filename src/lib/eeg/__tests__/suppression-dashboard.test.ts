import { describe, expect, it } from "vitest";

import {
  APP_FLAG_PCT,
  buildSuppressionDashboard,
  caseTrace,
  gateStatus,
  MAX_TRACE_SAMPLES,
  thin,
} from "../suppression-dashboard";
import {
  crossValidate,
  MONITOR_SUPPRESSED_PCT,
  type SuppressionPoint,
} from "../suppression-model";

function point(over: Partial<SuppressionPoint> = {}): SuppressionPoint {
  return {
    caseRef: "case-1",
    atSeconds: 0,
    appSr: 0,
    bisSr: 0,
    appIndex: 50,
    bis: 50,
    sqi: 0.9,
    reliable: true,
    ...over,
  };
}

/** A record that starts clear and ends deeply suppressed. */
function record(caseRef: string, n = 60): SuppressionPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const deep = i >= n / 2;
    return point({
      caseRef,
      atSeconds: i * 10,
      appSr: deep ? 40 + (i % 5) : 0,
      bisSr: deep ? 45 + (i % 5) : 0,
      appIndex: deep ? 62 : 55,
      bis: deep ? 25 : 52,
    });
  });
}

describe("thin", () => {
  it("leaves short traces alone", () => {
    const rows = [1, 2, 3];
    expect(thin(rows, 10)).toEqual(rows);
  });

  it("caps long traces and always keeps the last sample", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => i);
    const out = thin(rows);
    expect(out.length).toBeLessThanOrEqual(MAX_TRACE_SAMPLES + 1);
    expect(out[out.length - 1]).toBe(4999);
  });
});

describe("caseTrace", () => {
  it("counts flag agreement against the monitor threshold", () => {
    const rows = [
      point({ atSeconds: 0, appSr: 0, bisSr: 0 }),
      point({ atSeconds: 10, appSr: 40, bisSr: 40 }),
      point({ atSeconds: 20, appSr: 0, bisSr: 40 }),
      point({ atSeconds: 30, appSr: 40, bisSr: 0 }),
    ];
    const t = caseTrace("case-1", rows, null);
    expect(t.flags).toEqual({ agreed: 1, missed: 1, falseAlarms: 1, clear: 1 });
    expect(t.points).toBe(4);
    expect(t.durationSeconds).toBe(30);
  });

  it("uses the same threshold for both flags", () => {
    expect(APP_FLAG_PCT).toBe(MONITOR_SUPPRESSED_PCT);
  });

  it("only ever pulls the depth number down", () => {
    const t = caseTrace("case-1", record("case-1"), null);
    for (const s of t.samples) {
      if (s.index == null || s.cappedIndex == null) continue;
      expect(s.cappedIndex).toBeLessThanOrEqual(s.index);
    }
    expect(t.capEngaged).toBeGreaterThan(0);
    expect(t.maxCapShift).toBeGreaterThan(0);
    expect(t.meanCappedIndex!).toBeLessThan(t.meanIndex!);
  });

  it("orders samples by time even when the readings arrive unsorted", () => {
    const t = caseTrace("case-1", [
      point({ atSeconds: 30 }),
      point({ atSeconds: 10 }),
      point({ atSeconds: 20 }),
    ], null);
    expect(t.samples.map((s) => s.at)).toEqual([10, 20, 30]);
  });

  it("counts readings that still read light inside recorded suppression", () => {
    const rows = [point({ atSeconds: 0, appSr: 0, bisSr: 40, appIndex: 90, bis: 20 })];
    expect(caseTrace("case-1", rows, null).falselyLight).toBe(1);
  });
});

describe("gateStatus", () => {
  it("reports what is missing when the fit cannot act", () => {
    const fit = crossValidate("vitaldb", [point()]);
    const gate = gateStatus(fit);
    expect(gate.active).toBe(false);
    expect(gate.blockedBy).toBeTruthy();
    expect(gate.requiredCases).toBeGreaterThan(0);
  });
});

describe("buildSuppressionDashboard", () => {
  const points = [
    ...record("case-a"),
    ...record("case-b"),
    ...record("case-c"),
    ...[point({ caseRef: "case-d", atSeconds: 0 })],
  ];
  const fit = crossValidate("vitaldb", points);

  it("groups readings into per-case traces", () => {
    const dash = buildSuppressionDashboard(points, fit);
    expect(dash.cases.map((c) => c.caseRef).sort()).toEqual([
      "case-a",
      "case-b",
      "case-c",
      "case-d",
    ]);
  });

  it("ranks the cases with recorded suppression first", () => {
    const dash = buildSuppressionDashboard(points, fit);
    expect(dash.cases[0]!.caseRef).not.toBe("case-d");
  });

  it("honours the case limit", () => {
    expect(buildSuppressionDashboard(points, fit, 2).cases).toHaveLength(2);
  });

  it("totals flag agreement over the cases shown", () => {
    const dash = buildSuppressionDashboard(points, fit);
    const summed = dash.cases.reduce(
      (acc, c) => ({
        agreed: acc.agreed + c.flags.agreed,
        missed: acc.missed + c.flags.missed,
        falseAlarms: acc.falseAlarms + c.flags.falseAlarms,
        clear: acc.clear + c.flags.clear,
      }),
      { agreed: 0, missed: 0, falseAlarms: 0, clear: 0 },
    );
    expect(dash.totals).toEqual(summed);
  });

  it("returns an empty dashboard for no readings", () => {
    const dash = buildSuppressionDashboard([], crossValidate("vitaldb", []));
    expect(dash.cases).toEqual([]);
    expect(dash.totals).toEqual({ agreed: 0, missed: 0, falseAlarms: 0, clear: 0 });
    expect(dash.gate.active).toBe(false);
  });
});
