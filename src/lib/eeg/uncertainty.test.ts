import { describe, expect, it } from "vitest";

import { computeUncertainty, wilsonInterval, confidenceBand } from "@/lib/eeg/uncertainty";
import type { Epoch } from "@/lib/eeg/analysis";

function epoch(
  t: number,
  over: Partial<{
    sef95: number;
    epochSuppression: number;
    seizureScore: number;
    quality: number;
    emg: number;
    artifact: boolean;
  }> = {},
): Epoch {
  const q = over.quality ?? 0.9;
  return {
    t,
    sef95: over.sef95 ?? 12,
    epochSuppression: over.epochSuppression ?? 0,
    seizureScore: over.seizureScore ?? 0.1,
    artifact: over.artifact ?? false,
    amplitudeUv: 40,
    bands: { delta: 4, theta: 2, alpha: 2, beta: 1, gamma: 1 },
    quality: { score: q, emgIndex: over.emg ?? 0.05 },
    confidence: { spectral: q, suppression: q, seizure: q, depth: q },
  } as unknown as Epoch;
}

const OPTS = { srWindowSeconds: 60, seizureThreshold: 0.6 };

describe("wilsonInterval", () => {
  it("stays inside 0–1 at the boundaries", () => {
    const zero = wilsonInterval(0, 10);
    expect(zero.low).toBe(0);
    expect(zero.high).toBeGreaterThan(0);
    const one = wilsonInterval(1, 10);
    expect(one.high).toBe(1);
    expect(one.low).toBeLessThan(1);
  });

  it("narrows as n grows", () => {
    const few = wilsonInterval(0.5, 5);
    const many = wilsonInterval(0.5, 200);
    expect(many.high - many.low).toBeLessThan(few.high - few.low);
  });
});

describe("computeUncertainty", () => {
  it("reports an empty assessment with no epochs", () => {
    const r = computeUncertainty([], OPTS);
    expect(r.spectral.interval).toBeNull();
    expect(r.suppression.point).toBeNull();
    expect(r.seizure.samples).toBe(0);
  });

  it("brackets the mean SEF95 within its interval", () => {
    const epochs = Array.from({ length: 40 }, (_, i) => epoch(i, { sef95: 12 + (i % 2) }));
    const { spectral } = computeUncertainty(epochs, OPTS);
    expect(spectral.point).toBeGreaterThan(12);
    expect(spectral.interval!.low).toBeLessThanOrEqual(spectral.point!);
    expect(spectral.interval!.high).toBeGreaterThanOrEqual(spectral.point!);
    expect(spectral.factors.length).toBeGreaterThan(2);
  });

  it("widens the interval when confidence is low", () => {
    const clean = Array.from({ length: 40 }, (_, i) => epoch(i, { sef95: 12 + (i % 3) }));
    const noisy = clean.map((e, i) => epoch(i, { sef95: 12 + (i % 3), quality: 0.2, emg: 0.5 }));
    const a = computeUncertainty(clean, OPTS).spectral.interval!;
    const b = computeUncertainty(noisy, OPTS).spectral.interval!;
    expect(b.high - b.low).toBeGreaterThan(a.high - a.low);
  });

  it("estimates the suppression ratio with a Wilson interval", () => {
    const epochs = Array.from({ length: 60 }, (_, i) =>
      epoch(i, { epochSuppression: i % 2 === 0 ? 1 : 0 }),
    );
    const { suppression } = computeUncertainty(epochs, OPTS);
    expect(suppression.point).toBeCloseTo(50, 0);
    expect(suppression.interval!.low).toBeGreaterThanOrEqual(0);
    expect(suppression.interval!.high).toBeLessThanOrEqual(100);
    expect(suppression.factors.some((f) => f.key === "fill")).toBe(true);
  });

  it("excludes artefact epochs from every assessment", () => {
    const epochs = [
      ...Array.from({ length: 20 }, (_, i) => epoch(i)),
      ...Array.from({ length: 10 }, (_, i) => epoch(20 + i, { artifact: true, sef95: 30 })),
    ];
    const r = computeUncertainty(epochs, OPTS);
    expect(r.spectral.samples).toBe(20);
    expect(r.spectral.point).toBeCloseTo(12, 5);
  });

  it("penalises seizure confidence factors for EMG", () => {
    const epochs = Array.from({ length: 30 }, (_, i) =>
      epoch(i, { seizureScore: 0.8, emg: 0.6, quality: 0.4 }),
    );
    const { seizure } = computeUncertainty(epochs, OPTS);
    const emg = seizure.factors.find((f) => f.key === "emg")!;
    expect(emg.impact).toBeLessThan(0);
    expect(seizure.factors.find((f) => f.key === "persistence")!.impact).toBeGreaterThan(0);
    expect(seizure.caveats.length).toBeGreaterThan(1);
  });
});

describe("confidenceBand", () => {
  it("bands 0–1 confidence", () => {
    expect(confidenceBand(0.9)).toBe("high");
    expect(confidenceBand(0.5)).toBe("moderate");
    expect(confidenceBand(0.2)).toBe("low");
  });
});
