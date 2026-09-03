import { describe, expect, it } from "vitest";

import {
  describeWeights,
  diffWeights,
  trainingSummary,
  versionVerdict,
  type StoredCoefficients,
} from "../coebis-version-history";

const V1: StoredCoefficients = {
  gain: 0.92,
  offset: 3.4,
  knots: [{ x: 40, dy: -1.5 }],
  terms: [
    { group: "age", level: "75-89", dy: -2.4, n: 120 },
    { group: "sex", level: "female", dy: 0.8, n: 90 },
  ],
  ceTerms: [{ drug: "propofol", linear: -1.2, curvature: 0.3, n: 60 }],
};

const V2: StoredCoefficients = {
  ...V1,
  gain: 0.95,
  terms: [
    { group: "age", level: "75-89", dy: -3.1, n: 180 },
    { group: "frailty", level: "frail", dy: -1.1, n: 40 },
  ],
};

describe("COEBIS version history", () => {
  it("flattens stored coefficients into labelled weights", () => {
    const w = describeWeights("covariate", V1);
    expect(w.map((x) => x.id)).toEqual([
      "shape:gain",
      "shape:offset",
      "shape:knot:40",
      "cov:age:75-89",
      "cov:sex:female",
      "ce:propofol:linear",
      "ce:propofol:curve",
    ]);
    expect(w.find((x) => x.id === "cov:age:75-89")).toMatchObject({
      kind: "covariate",
      value: -2.4,
      n: 120,
    });
    expect(w.find((x) => x.id === "cov:age:75-89")!.label).toContain("Age band");
  });

  it("shows only shape weights for a raw model and tolerates missing coefficients", () => {
    expect(describeWeights("raw", V1).every((w) => w.kind === "shape")).toBe(true);
    expect(describeWeights("covariate", null)).toEqual([]);
    expect(describeWeights("covariate", { terms: [{ group: "age", level: "x", dy: NaN }] })).toEqual(
      [],
    );
  });

  it("diffs weights against the previous version, keeping dropped terms visible", () => {
    const rows = diffWeights(describeWeights("covariate", V2), describeWeights("covariate", V1));
    const age = rows.find((r) => r.id === "cov:age:75-89")!;
    expect(age).toMatchObject({ previous: -2.4, delta: -0.7, status: "changed" });
    expect(rows.find((r) => r.id === "cov:frailty:frail")!.status).toBe("added");
    const dropped = rows.find((r) => r.id === "cov:sex:female")!;
    expect(dropped).toMatchObject({ status: "removed", previous: 0.8, value: 0, delta: -0.8 });
    expect(rows.find((r) => r.id === "shape:knot:40")!.status).toBe("same");
  });

  it("treats a first version as having nothing to compare against", () => {
    const rows = diffWeights(describeWeights("covariate", V1), null);
    expect(rows.every((r) => r.status === "same" && r.previous === null)).toBe(true);
  });

  it("states plainly whether a version went live and what it bought", () => {
    expect(
      versionVerdict({ promoted: true, isActive: true, maeGain: 0.6, before: {}, after: {} }),
    ).toBe("Live model — held-out MAE improved by 0.60.");
    expect(
      versionVerdict({ promoted: false, isActive: false, maeGain: -0.2, before: {}, after: {} }),
    ).toBe("Kept as a candidate only — held-out MAE worsened by 0.20.");
    expect(
      versionVerdict({ promoted: true, isActive: false, maeGain: null, before: {}, after: {} }),
    ).toContain("since superseded");
  });

  it("summarises the training set behind a version", () => {
    expect(trainingSummary({ n: 240, cases: 9, folds: 9, passRate: 0.812 })).toBe(
      "240 validated readings · 9 cases · 9 leave-one-case-out folds · 81% of offered readings passed validation",
    );
    expect(trainingSummary({})).toBe("0 validated readings · 0 cases");
  });
});
