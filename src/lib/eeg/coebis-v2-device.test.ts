import { describe, expect, it } from "vitest";

import {
  MUSE_2_PROFILE,
  REGUL8_PROFILE,
  FOCUSCALM_PROFILE,
  FRONTAL_PAIR_PROFILE,
  ANALYSIS_SAMPLE_RATE,
} from "./device-profile";
import {
  COEBIS_V2_RELATIVE_FEATURES,
  LiveCoebisV2,
  coebisV2DeviceSetup,
} from "./coebis-v2-device";
import * as deviceModule from "./coebis-v2-device";

/** Pink-ish anaesthetised-looking window: slow-dominant with a little beta. */
function window(seconds: number, rate: number, amplitudeUv: number): Float64Array {
  const n = Math.round(seconds * rate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    out[i] =
      amplitudeUv *
      (Math.sin(2 * Math.PI * 1.2 * t) +
        0.4 * Math.sin(2 * Math.PI * 9 * t) +
        0.1 * Math.sin(2 * Math.PI * 20 * t));
  }
  return out;
}

describe("COEBIS-2 device setup", () => {
  it("treats the fitted bilateral frontal montage as readable", () => {
    const setup = coebisV2DeviceSetup(FRONTAL_PAIR_PROFILE);
    expect(setup.applicability).toBe("near");
    expect(setup.amplitudeCalibrated).toBe(true);
    expect(setup.withheldReason).toBeNull();
  });

  it("uses every Muse electrode and says the temporal pair was never fitted", () => {
    const setup = coebisV2DeviceSetup(MUSE_2_PROFILE);
    expect(setup.channels).toEqual(["TP9", "AF7", "AF8", "TP10"]);
    expect(setup.applicability).toBe("extrapolated");
    expect(setup.caveats.join(" ")).toMatch(/TP9 and TP10/);
    expect(setup.caveats.join(" ")).toMatch(/256 Hz/);
  });

  it("can be restricted to the forehead pair the model was fitted on", () => {
    const setup = coebisV2DeviceSetup(MUSE_2_PROFILE, { useAllChannels: false });
    expect(setup.channels).toEqual(["AF7", "AF8"]);
    expect(setup.excluded).toEqual(["TP9", "TP10"]);
    expect(setup.applicability).toBe("near");
  });

  it("withholds COEBIS-2 on bands with no microvolt scale, with a stated reason", () => {
    for (const profile of [REGUL8_PROFILE, FOCUSCALM_PROFILE]) {
      const setup = coebisV2DeviceSetup(profile);
      expect(setup.amplitudeCalibrated).toBe(false);
      expect(setup.withheldReason).toMatch(/microvolt scale/);
      expect(setup.verdict).toMatch(/Withheld/);
      expect(setup.applicability).toBe("extrapolated");
    }
  });

  it("no longer exports a training-RMS rescaler", () => {
    expect("fittedReferenceRms" in deviceModule).toBe(false);
  });
});

describe("live COEBIS-2 on a headband", () => {
  it("produces a bounded index on a calibrated Muse-rate stream", () => {
    const live = new LiveCoebisV2(MUSE_2_PROFILE);
    let reading = null as ReturnType<LiveCoebisV2["update"]>;
    for (let i = 0; i < 30; i++) {
      reading = live.update(window(4, ANALYSIS_SAMPLE_RATE, 20), ANALYSIS_SAMPLE_RATE, 1);
    }
    expect(reading).not.toBeNull();
    expect(reading!.status).toBe("available");
    expect(reading!.index).toBeGreaterThanOrEqual(0);
    expect(reading!.index).toBeLessThanOrEqual(100);
    expect(reading!.suppressionRatio).not.toBeNull();
    expect(reading!.modelVersion).toMatch(/^coebis-v2\|/);
  });

  it("returns null index and null suppression on an auto-gained band — never a rescaled guess", () => {
    const live = new LiveCoebisV2(REGUL8_PROFILE);
    let reading = null as ReturnType<LiveCoebisV2["update"]>;
    for (let i = 0; i < 5; i++) {
      reading = live.update(window(4, ANALYSIS_SAMPLE_RATE, 2000), ANALYSIS_SAMPLE_RATE, 1);
    }
    expect(reading).not.toBeNull();
    expect(reading!.status).toBe("withheld");
    expect(reading!.index).toBeNull();
    expect(reading!.instant).toBeNull();
    expect(reading!.suppressionRatio).toBeNull();
    expect(reading!.terms).toBeNull();
    expect(reading!.drivers).toEqual([]);
    expect(reading!.withheldReason).toMatch(/microvolt scale/);
    expect("gain" in reading!).toBe(false);
  });

  it("keeps only scale-invariant research features when withheld", () => {
    const a = new LiveCoebisV2(REGUL8_PROFILE).update(
      window(4, ANALYSIS_SAMPLE_RATE, 2000),
      ANALYSIS_SAMPLE_RATE,
    )!;
    const b = new LiveCoebisV2(REGUL8_PROFILE).update(
      window(4, ANALYSIS_SAMPLE_RATE, 3),
      ANALYSIS_SAMPLE_RATE,
    )!;
    const keys = Object.keys(a.researchFeatures);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect((COEBIS_V2_RELATIVE_FEATURES as readonly string[]).includes(k)).toBe(true);
      // Same shape at a 600× different scale gives the same relative features.
      const va = a.researchFeatures[k as keyof typeof a.researchFeatures]!;
      const vb = b.researchFeatures[k as keyof typeof b.researchFeatures]!;
      expect(Math.abs(va - vb)).toBeLessThan(1e-6 + Math.abs(va) * 1e-6);
    }
    for (const absolute of ["logRms", "logPtp", "logTotal", "logDelta", "suppFraction", "sr60"]) {
      expect(absolute in a.researchFeatures).toBe(false);
    }
  });
});
