import { describe, expect, it } from "vitest";

import {
  MUSE_2_PROFILE,
  REGUL8_PROFILE,
  FRONTAL_PAIR_PROFILE,
  ANALYSIS_SAMPLE_RATE,
} from "./device-profile";
import { LiveCoebisV2, coebisV2DeviceSetup, fittedReferenceRms } from "./coebis-v2-device";

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
    expect(setup.amplitudeNormalised).toBe(false);
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

  it("flags the Regul8 band as unilateral and amplitude-normalised", () => {
    const setup = coebisV2DeviceSetup(REGUL8_PROFILE);
    expect(setup.amplitudeNormalised).toBe(true);
    expect(setup.applicability).toBe("extrapolated");
    expect(setup.caveats.join(" ")).toMatch(/One side of the head/);
  });
});

describe("live COEBIS-2 on a headband", () => {
  it("produces a bounded index on a Muse-rate stream", () => {
    const live = new LiveCoebisV2(MUSE_2_PROFILE);
    let reading = null as ReturnType<LiveCoebisV2["update"]>;
    for (let i = 0; i < 30; i++) {
      reading = live.update(window(4, ANALYSIS_SAMPLE_RATE, 20), ANALYSIS_SAMPLE_RATE, 1);
    }
    expect(reading).not.toBeNull();
    expect(reading!.index).toBeGreaterThanOrEqual(0);
    expect(reading!.index).toBeLessThanOrEqual(100);
    expect(reading!.gain).toBe(1);
  });

  it("rescales an auto-gained band towards the amplitude it was fitted at", () => {
    const live = new LiveCoebisV2(REGUL8_PROFILE);
    // Arbitrary units, far from microvolts.
    for (let i = 0; i < 5; i++) live.update(window(4, ANALYSIS_SAMPLE_RATE, 2000), ANALYSIS_SAMPLE_RATE, 1);
    const reading = live.update(window(4, ANALYSIS_SAMPLE_RATE, 2000), ANALYSIS_SAMPLE_RATE, 1);
    expect(reading).not.toBeNull();
    expect(reading!.amplitudeNormalised).toBe(true);
    const rms = 2000 * Math.sqrt((1 + 0.4 ** 2 + 0.1 ** 2) / 2);
    expect(reading!.gain * rms).toBeGreaterThan(fittedReferenceRms() * 0.5);
    expect(reading!.gain * rms).toBeLessThan(fittedReferenceRms() * 2);
  });
});
