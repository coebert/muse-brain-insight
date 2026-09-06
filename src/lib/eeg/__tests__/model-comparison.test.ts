import { describe, expect, it } from "vitest";

import type { CohortContrast } from "../case-outcomes";
import type { LineageComparison } from "../lineage-comparison";
import { buildDepthArms, outcomeBars, suppressionScore } from "../model-comparison";
import type { SuppressionDashboard } from "../suppression-dashboard";

const summary = (n: number, mae: number, within5: number, bias: number) => ({
  n,
  bias,
  mae,
  rmse: mae * 1.2,
  within5,
  within10: Math.min(1, within5 * 1.5),
  ccc: 0.7,
});

const lineage = (
  lineageKey: string,
  points: number,
  cases: number,
  hasModel: boolean,
  mae: number,
): LineageComparison => ({
  lineageKey,
  hasModel,
  modelFamily: hasModel ? "affine" : null,
  modelVersion: hasModel ? 1 : null,
  points,
  cases,
  firstAt: null,
  lastAt: null,
  monitors: [],
  series: [],
  coebis: hasModel ? summary(points, mae, 0.5, 2) : null,
  raw: summary(points, mae + 3, 0.3, 8),
  maeGain: hasModel ? 3 : null,
  sufficient: hasModel,
  verdict: "",
});

describe("buildDepthArms", () => {
  it("splits headband setups from the research corpora and pools by size", () => {
    const arms = buildDepthArms([
      lineage("vitaldb|BIS|128", 1000, 30, true, 6),
      lineage("figshare-ma-bis|AF7|125", 1000, 20, true, 10),
      lineage("muse-2|AF7|256", 21, 6, true, 19),
      lineage("unattributed", 500, 5, false, 20),
    ]);

    const shared = arms.find((a) => a.key === "shared")!;
    expect(shared.points).toBe(2000);
    expect(shared.modelMae).toBe(8); // equal weights, (6 + 10) / 2
    expect(shared.readable).toBe(true);
    expect(shared.lineages).not.toContain("unattributed");

    const headband = arms.find((a) => a.key === "headband")!;
    expect(headband.points).toBe(21);
    expect(headband.modelMae).toBe(19);
    expect(headband.gain).toBe(3);
  });

  it("marks an arm unreadable when it has no promoted model", () => {
    const arms = buildDepthArms([lineage("regul8|AF7|250", 40, 4, false, 25)]);
    expect(arms.find((a) => a.key === "headband")!.readable).toBe(false);
  });
});

describe("suppressionScore", () => {
  it("reads sensitivity and false alarms off the flag totals", () => {
    const dash = {
      totals: { agreed: 40, missed: 10, falseAlarms: 10, clear: 940 },
      bisTotals: { maeCapped: 7.2, maeRaw: 8.1 },
    } as unknown as SuppressionDashboard;
    const score = suppressionScore(dash);
    expect(score.n).toBe(1000);
    expect(score.sensitivity).toBe(0.8);
    expect(score.falseAlarmRate).toBe(0.2);
    expect(score.agreement).toBe(0.98);
    expect(score.readable).toBe(true);
  });

  it("is unreadable with too few suppressed moments", () => {
    const score = suppressionScore(null);
    expect(score.readable).toBe(false);
    expect(score.sensitivity).toBeNull();
  });
});

describe("outcomeBars", () => {
  it("flattens contrasts and keeps the underpowered flag", () => {
    const contrast: CohortContrast = {
      key: "icuStay",
      label: "Needed intensive care",
      withN: 12,
      withoutN: 4,
      unknownN: 0,
      withMinutesBelow40: 65,
      withoutMinutesBelow40: 21,
      withFractionBelow40: 0.4,
      withoutFractionBelow40: 0.1,
      withMinutesSuppressed: 8,
      withoutMinutesSuppressed: 2,
      underpowered: true,
    };
    const [bar] = outcomeBars([contrast]);
    expect(bar!.withDeep).toBe(65);
    expect(bar!.underpowered).toBe(true);
  });
});
