import { describe, expect, it } from "vitest";

import {
  describeHarmonization,
  harmonizeEpoch,
  harmonizeEpochs,
  inferReference,
  planHarmonization,
  HARMONIZATION_VERSION,
  type SourceMontage,
} from "./harmonization";
import type { PhysionetEpoch } from "./physionet";

const epoch: PhysionetEpoch = {
  caseRef: "c1",
  channel: "FP1-A1",
  atSeconds: 0,
  epochSeconds: 4,
  sampleRate: 250,
  spectrumDb: [10, 8, 6, 4],
  bands: { delta: 40, theta: 20, alpha: 10, beta: 5, gamma: 2 },
  totalPower: 77,
  sef95: 12,
  suppressionRatio: 0,
  isSuppressed: false,
  label: null,
  labelSource: "derived",
  externalRef: "ref-1",
};

const mastoid: SourceMontage = {
  channel: "FP1-A1",
  reference: "mastoid",
  lowHz: 0.1,
  highHz: 50,
  sampleRateHz: 250,
};

describe("reference inference", () => {
  it("reads the reference from the published channel label", () => {
    expect(inferReference("FP1-A1")).toBe("mastoid");
    expect(inferReference("F7-LE")).toBe("linked-ears");
    expect(inferReference("FP2-AVG")).toBe("average");
    expect(inferReference("FP1-CZ")).toBe("cz");
    expect(inferReference("AF7-AF8")).toBe("bipolar-frontal");
    expect(inferReference(null)).toBe("unknown");
  });
});

describe("harmonisation plan", () => {
  it("records every transformation step and stays approximate", () => {
    const plan = planHarmonization(mastoid);
    expect(plan.version).toBe(HARMONIZATION_VERSION);
    expect(plan.approximate).toBe(true);
    expect(plan.steps.map((s) => s.step)).toContain("reference-normalisation");
    expect(plan.steps.map((s) => s.step)).toContain("band-limit");
    // Mastoid montage records larger swings, so the gain is negative.
    expect(plan.totalGainDb).toBeLessThan(0);
    expect(plan.bandCoverage).toBe(1);
    expect(plan.caveats.join(" ")).toMatch(/approximation/i);
  });

  it("applies no reference gain when the scheme is undocumented", () => {
    const plan = planHarmonization({
      channel: null,
      reference: "unknown",
      lowHz: null,
      highHz: null,
      sampleRateHz: null,
    });
    expect(plan.totalGainDb).toBe(0);
    expect(plan.confidence).toBeLessThan(0.5);
    expect(plan.caveats.join(" ")).toMatch(/not documented/i);
  });

  it("marks bands the source passband cannot support", () => {
    const plan = planHarmonization({ ...mastoid, highHz: 20 });
    expect(plan.unusableBands).toContain("gamma");
    expect(plan.unusableBands).toContain("beta");
    expect(plan.bandCoverage).toBeLessThan(1);
  });
});

describe("applying harmonisation", () => {
  it("rescales power without inventing detector verdicts", () => {
    const out = harmonizeEpoch(epoch, mastoid);
    const linear = Math.pow(10, out.harmonization.totalGainDb / 10);
    expect(out.bands.delta).toBeCloseTo(40 * linear, 6);
    expect(out.spectrumDb[0]).toBeCloseTo(10 + out.harmonization.totalGainDb, 3);
    // Shape-preserving: SEF95 and the suppression label are untouched.
    expect(out.sef95).toBe(epoch.sef95);
    expect(out.isSuppressed).toBe(false);
    expect(out.suppressionRatio).toBe(0);
    expect(out.totalPower).toBeCloseTo(77 * linear, 5);
  });

  it("zeroes bands the source cannot support", () => {
    const out = harmonizeEpoch(epoch, { ...mastoid, highHz: 20 });
    expect(out.bands.gamma).toBe(0);
    expect(out.bands.delta).toBeGreaterThan(0);
  });

  it("plans once per case and yields an audit line", () => {
    const rows = harmonizeEpochs([epoch, { ...epoch, externalRef: "ref-2" }], mastoid);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.harmonization).toEqual(rows[1]!.harmonization);
    expect(describeHarmonization(rows[0]!.harmonization)).toMatch(
      /mastoid → bipolar-frontal/,
    );
  });
});
