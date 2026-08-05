import { describe, expect, it } from "vitest";

import { DepthArtifactGate, ecgLikeness, robustSigma } from "@/lib/eeg/artifact";
import { computePsd } from "@/lib/eeg/dsp";

const FS = 256;

function build(seconds: number, fill: (i: number, t: number) => number): Float64Array {
  const n = Math.round(FS * seconds);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fill(i, i / FS);
  return out;
}

function noise(amplitude: number, seed = 3) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648 - 0.5) * 2 * amplitude;
  };
}

/** Physiological-looking anaesthetic EEG: delta + alpha + a little noise. */
function cleanEeg(seconds = 4): Float64Array {
  const rnd = noise(3);
  return build(
    seconds,
    (_, t) => 30 * Math.sin(2 * Math.PI * 1.5 * t) + 12 * Math.sin(2 * Math.PI * 10 * t) + rnd(),
  );
}

function evaluate(signal: Float64Array, gate = new DepthArtifactGate(), quality = 0.9) {
  return gate.evaluate(signal, computePsd(signal, FS), FS, quality);
}

describe("robustSigma", () => {
  it("is unmoved by a handful of huge outliers", () => {
    const base = cleanEeg();
    const withBlink = Float64Array.from(base);
    for (let i = 100; i < 140; i++) withBlink[i] = 800;
    const before = robustSigma(base);
    const after = robustSigma(withBlink);
    expect(Math.abs(after - before) / before).toBeLessThan(0.15);
  });

  it("is zero for a flat trace", () => {
    expect(robustSigma(new Float64Array(512))).toBe(0);
  });
});

describe("ecgLikeness", () => {
  it("scores a metronomic spike train highly", () => {
    const rnd = noise(1);
    const spikey = build(6, (i) => (i % Math.round(FS / 1.2) < 2 ? 120 : rnd()));
    expect(ecgLikeness(spikey, FS)).toBeGreaterThan(0.6);
  });

  it("scores clean rhythmic EEG at zero", () => {
    expect(ecgLikeness(cleanEeg(6), FS)).toBe(0);
  });

  it("returns zero for a segment shorter than two seconds", () => {
    expect(ecgLikeness(cleanEeg(1), FS)).toBe(0);
  });
});

describe("DepthArtifactGate", () => {
  it("accepts physiological EEG", () => {
    const { report } = evaluate(cleanEeg());
    expect(report.usable).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it("rejects a flat trace as lost electrode contact", () => {
    const { report } = evaluate(new Float64Array(FS * 4));
    expect(report.usable).toBe(false);
    expect(report.reasons.join(" ")).toMatch(/electrode contact/i);
  });

  it("rejects amplifier saturation", () => {
    const sat = cleanEeg();
    for (let i = 0; i < sat.length; i++) if (i % 7 === 0) sat[i] = 400;
    const { report } = evaluate(sat);
    expect(report.saturationFraction).toBeGreaterThan(0.01);
    expect(report.reasons.join(" ")).toMatch(/saturation/i);
  });

  it("rejects frontalis EMG that dominates the beta ratio", () => {
    // High-frequency-weighted contamination, as frontalis EMG appears on a
    // frontal montage.
    const emg = build(4, (_, t) => {
      let v = 5 * Math.sin(2 * Math.PI * 1.5 * t);
      for (let f = 30; f <= 45; f += 1.5) v += 14 * Math.sin(2 * Math.PI * f * t + f);
      return v;
    });
    const { report } = evaluate(emg);
    expect(report.emgIndex).toBeGreaterThan(0.34);
    expect(report.usable).toBe(false);
    expect(report.reasons.join(" ")).toMatch(/EMG/);
  });

  it("rejects a step rise in high-frequency power against the clean baseline", () => {
    const gate = new DepthArtifactGate();
    for (let i = 0; i < 8; i++) evaluate(cleanEeg(), gate);
    // Slow-wave-dominated epoch (deep anaesthesia) with EMG riding on top: the
    // relative share stays low, so only the surge test can catch it.
    const contaminated = build(4, (_, t) => {
      let v = 120 * Math.sin(2 * Math.PI * 1.2 * t);
      for (let f = 30; f <= 45; f += 1.5) v += 9 * Math.sin(2 * Math.PI * f * t + f);
      return v;
    });
    const { report } = evaluate(contaminated, gate);
    expect(report.emgSurge).toBeGreaterThan(4);
    expect(report.usable).toBe(false);
  });

  it("rejects an epoch whose overall quality score is too low", () => {
    const { report } = evaluate(cleanEeg(), new DepthArtifactGate(), 0.2);
    expect(report.reasons.join(" ")).toMatch(/quality/i);
  });

  it("repairs bounded transients rather than clipping them", () => {
    const withBlink = cleanEeg();
    for (let i = 200; i < 260; i++) withBlink[i] = 500;
    const { signal, report } = evaluate(withBlink);
    expect(report.repairedFraction).toBeGreaterThan(0);
    let peak = 0;
    for (const v of signal) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(500);
  });

  it("only learns its EMG baseline from accepted epochs", () => {
    const gate = new DepthArtifactGate();
    for (let i = 0; i < 5; i++) evaluate(cleanEeg(), gate);
    // A flat epoch is rejected, so it must not move the baseline.
    evaluate(new Float64Array(FS * 4), gate);
    const { report } = evaluate(cleanEeg(), gate);
    expect(report.usable).toBe(true);
  });

  it("clears the baseline on reset", () => {
    const gate = new DepthArtifactGate();
    for (let i = 0; i < 5; i++) evaluate(cleanEeg(), gate);
    gate.reset();
    const { report } = evaluate(cleanEeg(), gate);
    expect(report.emgSurge).toBe(1);
  });
});
