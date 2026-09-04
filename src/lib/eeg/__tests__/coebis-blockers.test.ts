import { describe, expect, it } from "vitest";

import {
  buildLineageBlockers,
  covariateOpportunities,
  STABLE_CV_CASES,
  type LineageVersionRow,
} from "@/lib/eeg/coebis-blockers";
import type { CoebisTrainingPoint } from "@/lib/eeg/coebis-covariates";

function point(
  lineageKey: string,
  sessionId: string,
  extra: Partial<CoebisTrainingPoint> = {},
): CoebisTrainingPoint {
  return {
    at: 0,
    bis: 45,
    appIndex: 50,
    reliable: true,
    sqi: 0.9,
    sessionId,
    lineageKey,
    cov: {},
    ...extra,
  } as CoebisTrainingPoint;
}

function many(lineageKey: string, cases: number, per: number, extra: Partial<CoebisTrainingPoint> = {}) {
  const out: CoebisTrainingPoint[] = [];
  for (let c = 0; c < cases; c++) {
    for (let i = 0; i < per; i++) out.push(point(lineageKey, `case-${c}`, extra));
  }
  return out;
}

const noVersions: LineageVersionRow[] = [];

describe("buildLineageBlockers", () => {
  it("blocks on cases before readings and says how many more are needed", () => {
    const rows = buildLineageBlockers(many("muse-2|AF7-AF8|256", 2, 40), noVersions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("cases");
    expect(rows[0]!.casesNeeded).toBe(1);
    expect(rows[0]!.readingsNeeded).toBe(0);
    expect(rows[0]!.headline).toContain("1 more case");
  });

  it("blocks on readings once case cover is met", () => {
    const rows = buildLineageBlockers(many("muse-2|AF7-AF8|256", 4, 2), noVersions);
    expect(rows[0]!.status).toBe("readings");
    expect(rows[0]!.readingsNeeded).toBe(22);
  });

  it("separates an evidence block from a data block", () => {
    const rows = buildLineageBlockers(many("vitaldb|AF7-AF8|128", 5, 20), [
      {
        lineageKey: "vitaldb|AF7-AF8|128",
        version: 1,
        promoted: false,
        isActive: false,
        maeGain: -1.25,
        createdAt: null,
      },
    ]);
    expect(rows[0]!.status).toBe("evidence");
    expect(rows[0]!.casesNeeded).toBe(0);
    expect(rows[0]!.detail).toContain("-1.25");
  });

  it("marks a promoted lineage live and still flags a thin cross-validation", () => {
    const rows = buildLineageBlockers(many("vitaldb|AF7-AF8|128", 4, 20), [
      {
        lineageKey: "vitaldb|AF7-AF8|128",
        version: 2,
        promoted: true,
        isActive: true,
        maeGain: 1.17,
        createdAt: null,
      },
    ]);
    expect(rows[0]!.status).toBe("live");
    expect(rows[0]!.blocked).toBe(false);
    expect(rows[0]!.casesForStableCv).toBe(STABLE_CV_CASES - 4);
  });

  it("calls out readings with no lineage recorded", () => {
    const rows = buildLineageBlockers(
      many("x|AF7|128", 1, 1).map((p) => ({ ...p, lineageKey: null })),
      noVersions,
    );
    expect(rows[0]!.status).toBe("unattributed");
  });
});

describe("covariateOpportunities", () => {
  it("calls a covariate ready only when levels span independent cases", () => {
    const points = [
      ...many("l", 2, 10, { cov: { ageBand: "65-79" } }),
      ...many("l", 2, 10, { cov: { ageBand: "40-64" } }).map((p, i) => ({
        ...p,
        sessionId: `older-${Math.floor(i / 10)}`,
      })),
    ];
    const age = covariateOpportunities(points).find((c) => c.group === "age");
    expect(age?.status).toBe("ready");
    expect(age?.usableLevels).toBe(2);
    expect(age?.coverage).toBe(1);
  });

  it("marks a single-level covariate as constant, not ready", () => {
    const sex = covariateOpportunities(many("l", 5, 10, { cov: { sex: "female" } })).find(
      (c) => c.group === "sex",
    );
    expect(sex?.status).toBe("constant");
  });

  it("marks an unrecorded covariate as missing", () => {
    const frailty = covariateOpportunities(many("l", 5, 10)).find((c) => c.group === "frailty");
    expect(frailty?.status).toBe("missing");
    expect(frailty?.coverage).toBe(0);
  });

  it("grades effect-site concentrations on the cases that ran the drug", () => {
    const points = [
      ...many("l", 3, 5, { ce: { propofol: 4 } }),
      ...many("l", 3, 5, { ce: { propofol: 1 } }).map((p, i) => ({
        ...p,
        sessionId: `light-${Math.floor(i / 5)}`,
      })),
    ];
    const prop = covariateOpportunities(points).find((c) => c.group === "ce:propofol");
    expect(prop?.usableLevels).toBe(2);
    expect(prop?.status).toBe("ready");
  });
});
