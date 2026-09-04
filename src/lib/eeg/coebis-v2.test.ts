import { describe, expect, it } from "vitest";
import {
  CoebisV2Estimator,
  coebisV2Applicability,
  coebisV2WindowFeatures,
  COEBIS_V2_MODEL,
} from "./coebis-v2";

const FS = 128;

function synth(seconds: number, components: [number, number][], noise = 0): Float64Array {
  const out = new Float64Array(Math.round(seconds * FS));
  for (let i = 0; i < out.length; i++) {
    const t = i / FS;
    let v = 0;
    for (const [freq, amp] of components) v += amp * Math.sin(2 * Math.PI * freq * t);
    if (noise) v += noise * Math.sin(i * 12.9898) * Math.cos(i * 78.233);
    out[i] = v;
  }
  return out;
}

function run(signal: Float64Array, seconds = 60): number {
  const est = new CoebisV2Estimator({ ageYears: 55, sexMale: true });
  let last = 0;
  for (let s = 0; s < seconds; s++) {
    const start = ((s * FS) % Math.max(signal.length - 4 * FS, 1)) | 0;
    const window = signal.slice(start, start + 4 * FS);
    const r = est.update(window, FS, 1);
    if (r) last = r.index;
  }
  return last;
}

describe("coebis-v2 window features", () => {
  it("scores a flat trace as fully suppressed", () => {
    const flat = new Float64Array(4 * FS);
    const { suppressionFraction } = coebisV2WindowFeatures(flat, FS);
    expect(suppressionFraction).toBe(1);
  });

  it("does not call a large-amplitude trace suppressed", () => {
    const awake = synth(4, [[20, 30]]);
    const { suppressionFraction } = coebisV2WindowFeatures(awake, FS);
    expect(suppressionFraction).toBe(0);
  });
});

describe("coebis-v2 estimator", () => {
  it("reads a fast, low-amplitude trace higher than a slow-wave trace", () => {
    const light = run(synth(20, [[22, 18], [30, 10], [8, 4]], 2));
    const deep = run(synth(20, [[1.2, 60], [2.5, 40], [10, 6]], 1));
    expect(light).toBeGreaterThan(deep);
  });

  it("reports the trailing suppression ratio when the trace goes flat", () => {
    const est = new CoebisV2Estimator();
    const flat = new Float64Array(4 * FS);
    let reading = null;
    for (let s = 0; s < 90; s++) reading = est.update(flat, FS, 1) ?? reading;
    expect(reading!.suppressionRatio).toBeCloseTo(100, 5);
  });

  it("reads a suppressed trace below a light, fast trace", () => {
    const light = run(synth(20, [[22, 18], [30, 10], [8, 4]], 2));
    const suppressed = run(synth(20, [[1.5, 1.2]], 0));
    expect(suppressed).toBeLessThan(light);
  });


  it("keeps every reading inside the 0-100 scale", () => {
    for (const sig of [
      synth(20, [[40, 200]]),
      synth(20, [[0.6, 400]]),
      new Float64Array(20 * FS),
    ]) {
      const v = run(sig, 30);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("explains each reading with signed term contributions", () => {
    const est = new CoebisV2Estimator();
    let reading = null;
    const sig = synth(20, [[18, 20], [3, 25]], 2);
    for (let s = 0; s < 30; s++) {
      reading = est.update(sig.slice(s * FS, s * FS + 4 * FS), FS, 1) ?? reading;
    }
    expect(reading).not.toBeNull();
    expect(reading!.drivers.length).toBe(8);
    expect(reading!.drivers.every((d) => Number.isFinite(d.contribution))).toBe(true);
  });
});

describe("coebis-v2 lineage guard", () => {
  it("only claims the published error bar on the lineage it was fitted on", () => {
    expect(coebisV2Applicability(COEBIS_V2_MODEL.meta.lineage, 128, ["AF7", "AF8"])).toBe(
      "fitted",
    );
    expect(coebisV2Applicability("muse-2", 256, ["AF7", "AF8"])).toBe("near");
    expect(coebisV2Applicability("occipital-rig", 256, ["O1", "O2"])).toBe("extrapolated");
    expect(coebisV2Applicability(null, 20, ["AF7"])).toBe("extrapolated");
  });
});
