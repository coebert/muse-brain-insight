import { describe, expect, it } from "vitest";

import {
  describeHarmonization,
  harmonizeEpoch,
  harmonizeEpochs,
  inferReference,
  isHarmonizationFitCompatible,
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
  it("records the source reference but applies no invented gain", () => {
    const plan = planHarmonization(mastoid);
    expect(plan.version).toBe(HARMONIZATION_VERSION);
    expect(plan.totalGainDb).toBe(0);
    expect(plan.steps.every((s) => (s.gainDb ?? 0) === 0)).toBe(true);
    expect(plan.steps.map((s) => s.step)).not.toContain("reference-normalisation");
    expect(plan.steps.map((s) => s.step)).toContain("reference-preserved");
    expect(plan.source.reference).toBe("mastoid");
    expect(plan.referenceMatchesTarget).toBe(false);
    expect(plan.caveats.join(" ")).toMatch(/no correction was applied/i);
  });

  it("treats an undocumented scheme as unknown", () => {
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

  it("does not read a generic REF channel as an average reference", () => {
    expect(inferReference("FP1-REF")).toBe("unknown");
    expect(inferReference("FP1-AVG")).toBe("average");
  });

  it("marks bands the source passband cannot support", () => {
    const plan = planHarmonization({ ...mastoid, highHz: 20 });
    expect(plan.unusableBands).toContain("gamma");
    expect(plan.unusableBands).toContain("beta");
    expect(plan.bandCoverage).toBeLessThan(1);
  });
});

describe("applying harmonisation", () => {
  it("leaves the measured spectrum, powers and verdicts untouched", () => {
    const out = harmonizeEpoch(epoch, mastoid);
    expect(out.bands).toEqual(epoch.bands);
    expect(out.spectrumDb).toEqual(epoch.spectrumDb);
    expect(out.totalPower).toBe(77);
    expect(out.sef95).toBe(epoch.sef95);
    expect(out.isSuppressed).toBe(false);
    expect(out.availableTotalPower).toBe(77);
    expect(out.totalPowerPartial).toBe(false);
  });

  it("leaves unsupported bands unavailable rather than zero", () => {
    const out = harmonizeEpoch(epoch, { ...mastoid, highHz: 20 });
    expect(out.availableBands.gamma).toBeUndefined();
    expect("gamma" in out.availableBands).toBe(false);
    expect(out.bands.gamma).toBe(2); // original preserved, not overwritten
    expect(out.availableBands.delta).toBe(40);
    expect(out.totalPowerPartial).toBe(true);
    expect(out.availableTotalPower).toBe(70); // delta+theta+alpha only
  });

  it("plans once per case and yields an audit line", () => {
    const rows = harmonizeEpochs([epoch, { ...epoch, externalRef: "ref-2" }], mastoid);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.harmonization).toEqual(rows[1]!.harmonization);
    expect(describeHarmonization(rows[0]!.harmonization)).toMatch(
      /source reference mastoid preserved; no re-referencing/,
    );
  });
});

describe("fit compatibility", () => {
  it("rejects legacy harmonise-1.0.0 records until reprocessed", () => {
    const legacy = { ...planHarmonization(mastoid), version: "harmonise-1.0.0", totalGainDb: -2.92 };
    const r = isHarmonizationFitCompatible(legacy);
    expect(r.compatible).toBe(false);
    expect(r.reason).toMatch(/reprocess/i);
  });

  it("rejects a legacy record even when its gain was zero", () => {
    const legacy = { ...planHarmonization(mastoid), version: "harmonise-1.0.0" };
    expect(isHarmonizationFitCompatible(legacy).compatible).toBe(false);
  });

  it("rejects a missing record and any non-zero gain", () => {
    expect(isHarmonizationFitCompatible(null).compatible).toBe(false);
    const gained = { ...planHarmonization(mastoid), totalGainDb: 1.5 };
    expect(isHarmonizationFitCompatible(gained).compatible).toBe(false);
  });

  it("rejects records whose required bands are unavailable", () => {
    const plan = planHarmonization({ ...mastoid, highHz: 20 });
    expect(isHarmonizationFitCompatible(plan).compatible).toBe(false);
    expect(isHarmonizationFitCompatible(plan, ["delta", "theta"]).compatible).toBe(true);
  });

  it("accepts a current full-band record", () => {
    expect(isHarmonizationFitCompatible(planHarmonization(mastoid)).compatible).toBe(true);
  });
});
