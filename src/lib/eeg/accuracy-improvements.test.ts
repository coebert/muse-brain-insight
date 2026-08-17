import { describe, expect, it } from "vitest";

import {
  classifyStability,
  estimateMonitorLagSeconds,
  laggedAppIndex,
  sampleAt,
  slopePerMinute,
  type IndexSample,
} from "./pairing-lag";
import { benjaminiHochberg, pValueForMean } from "./fdr";
import { predictionProbability, rocAnalysis } from "./discrimination";
import { repeatedMeasuresBlandAltman } from "./bland-altman";
import { clusterRobustMeanCi } from "./ci";
import { coebisBaseline } from "./coebis-baseline";
import { empiricalInFitPercent } from "./coebis-fit-quality";
import { pairedFoldGain } from "./coebis-tiers";
import { computePsd, detectMainsHz, detrendInto, MUSE_SAMPLE_RATE } from "./dsp";
import { pointWeight } from "./bis-drift";

/** A smooth induction: index falls from 95 to 40 over five minutes. */
function inductionSeries(): IndexSample[] {
  const out: IndexSample[] = [];
  for (let t = 0; t <= 600; t += 1) out.push({ t, value: t <= 300 ? 95 - (55 * t) / 300 : 40 });
  return out;
}

describe("monitor lag alignment", () => {
  it("interpolates the index series between samples", () => {
    const s: IndexSample[] = [
      { t: 0, value: 100 },
      { t: 10, value: 50 },
    ];
    expect(sampleAt(s, 5)).toBeCloseTo(75, 6);
    expect(sampleAt(s, -5)).toBe(100);
    expect(sampleAt(s, 50)).toBe(50);
  });

  it("labels a steady stretch stable and a falling stretch transitional", () => {
    const s = inductionSeries();
    expect(classifyStability(slopePerMinute(s, 450))).toBe("stable");
    expect(classifyStability(slopePerMinute(s, 150))).toBe("transitional");
    expect(classifyStability(null)).toBe("unknown");
  });

  it("recovers a known monitor lag by minimising absolute error", () => {
    const series = inductionSeries();
    const lag = 20;
    const pairs = [];
    for (let at = 60; at <= 280; at += 10) {
      pairs.push({ at, bis: sampleAt(series, at - lag)!, series });
    }
    const est = estimateMonitorLagSeconds(pairs);
    expect(est.estimated).toBe(true);
    expect(est.lagSeconds).toBe(20);
    expect(est.maeGain).toBeGreaterThan(1);
  });

  it("falls back to the published delay without enough data", () => {
    const series = inductionSeries();
    const est = estimateMonitorLagSeconds([{ at: 100, bis: 70, series }]);
    expect(est.estimated).toBe(false);
    expect(est.lagSeconds).toBe(20);
  });

  it("re-pairs a reading against the lagged index", () => {
    const series = inductionSeries();
    expect(laggedAppIndex(series, 150, 20, 0)).toBeCloseTo(sampleAt(series, 130)!, 6);
    expect(laggedAppIndex([], 150, 20, 42)).toBe(42);
  });

  it("halves the weight of a transitional reading", () => {
    const base = { reliable: true, sqi: 100 };
    expect(pointWeight(base)).toBe(1);
    expect(pointWeight({ ...base, stability: "transitional" } as never)).toBeCloseTo(0.5, 6);
    expect(pointWeight({ ...base, stability: "stable" } as never)).toBe(1);
  });
});

describe("cluster-robust intervals", () => {
  it("widens the interval when readings cluster inside cases", () => {
    // Three cases, each with a strong case-level offset and little scatter.
    const values: { caseKey: string; value: number }[] = [];
    [0, 8, -8].forEach((offset, c) => {
      for (let i = 0; i < 10; i++) values.push({ caseKey: `case${c}`, value: offset + (i % 2 ? 0.2 : -0.2) });
    });
    const robust = clusterRobustMeanCi(values)!;
    const naiveSe = Math.sqrt(
      values.reduce((s, v) => s + v.value ** 2, 0) / (values.length - 1) / values.length,
    );
    expect(robust.icc).toBeGreaterThan(0.9);
    expect(robust.designEffect).toBeGreaterThan(5);
    expect(robust.se).toBeGreaterThan(naiveSe);
  });

  it("leaves an unclustered sample essentially uncorrected", () => {
    const values = Array.from({ length: 30 }, (_, i) => ({
      caseKey: `case${i}`,
      value: i % 2 ? 1 : -1,
    }));
    expect(clusterRobustMeanCi(values)!.designEffect).toBe(1);
  });
});

describe("multiplicity control", () => {
  it("adjusts p-values upward and keeps them monotone", () => {
    const out = benjaminiHochberg([
      { item: "a", p: 0.001 },
      { item: "b", p: 0.04 },
      { item: "c", p: 0.3 },
      { item: "d", p: 0.8 },
    ]);
    expect(out.map((o) => o.item)).toEqual(["a", "b", "c", "d"]);
    expect(out[0]!.q).toBeCloseTo(0.004, 4);
    expect(out[1]!.q).toBeCloseTo(0.08, 4);
    expect(out[1]!.significant).toBe(false);
    expect(out[0]!.significant).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i]!.q).toBeGreaterThanOrEqual(out[i - 1]!.q);
  });

  it("turns a mean and its standard error into a two-sided p-value", () => {
    expect(pValueForMean(0, 1)).toBeCloseTo(1, 2);
    expect(pValueForMean(1.96, 1)).toBeCloseTo(0.05, 2);
    expect(pValueForMean(5, null)).toBe(1);
  });
});

describe("discrimination", () => {
  it("scores a perfectly ordering index at Pk 1", () => {
    const obs = [
      { value: 95, rank: 0 },
      { value: 90, rank: 0 },
      { value: 60, rank: 1 },
      { value: 55, rank: 1 },
      { value: 40, rank: 2 },
      { value: 30, rank: 3 },
    ];
    const pk = predictionProbability(obs);
    expect(pk.pk).toBe(1);
    expect(pk.discordant).toBe(0);
    expect(pk.se).not.toBeNull();
  });

  it("scores an index that ignores state at about chance", () => {
    const obs = [
      { value: 50, rank: 0 },
      { value: 50, rank: 1 },
      { value: 50, rank: 2 },
      { value: 50, rank: 3 },
    ];
    expect(predictionProbability(obs).pk).toBe(0.5);
  });

  it("computes AUC and a Youden-optimal threshold for a boundary", () => {
    const roc = rocAnalysis([
      { value: 30, positive: true },
      { value: 35, positive: true },
      { value: 42, positive: true },
      { value: 70, positive: false },
      { value: 80, positive: false },
      { value: 90, positive: false },
    ]);
    expect(roc.auc).toBe(1);
    expect(roc.bestThreshold).toBe(42);
    expect(roc.bestYouden).toBe(1);
  });
});

describe("repeated-measures Bland-Altman", () => {
  it("separates within-case from between-case disagreement", () => {
    const pairs = [];
    for (const [c, offset] of [
      ["a", 6],
      ["b", -6],
      ["c", 0],
    ] as const) {
      for (let i = 0; i < 8; i++) {
        pairs.push({ caseKey: c, predicted: 50 + offset + (i % 2 ? 0.5 : -0.5), reference: 50 });
      }
    }
    const ba = repeatedMeasuresBlandAltman(pairs);
    expect(ba.cases).toBe(3);
    expect(ba.bias).toBeCloseTo(0, 1);
    expect(ba.betweenVariance!).toBeGreaterThan(ba.withinVariance!);
    expect(ba.icc!).toBeGreaterThan(0.9);
    expect(ba.limits).not.toBeNull();
  });

  it("reports plainly when there is too little data", () => {
    expect(repeatedMeasuresBlandAltman([{ caseKey: "a", predicted: 1, reference: 2 }]).limits).toBeNull();
  });
});

describe("tier promotion", () => {
  it("adopts a tier only when the gain beats its own scatter", () => {
    const simpler = ["a", "b", "c", "d"].map((caseKey) => ({ caseKey, n: 5, mae: 6 }));
    const consistent = ["a", "b", "c", "d"].map((caseKey) => ({ caseKey, n: 5, mae: 5 }));
    const noisy = [
      { caseKey: "a", n: 5, mae: 2 },
      { caseKey: "b", n: 5, mae: 10 },
      { caseKey: "c", n: 5, mae: 3 },
      { caseKey: "d", n: 5, mae: 9 },
    ];
    expect(pairedFoldGain(simpler, consistent).convincing).toBe(true);
    expect(pairedFoldGain(simpler, noisy).convincing).toBe(false);
  });
});

describe("quality-gated baseline", () => {
  it("ignores unreliable early values when enough clean ones exist", () => {
    const series = [
      ...Array.from({ length: 10 }, () => 90),
      ...Array.from({ length: 30 }, () => 45),
    ];
    const reliable = [...Array.from({ length: 10 }, () => false), ...Array.from({ length: 30 }, () => true)];
    const gated = coebisBaseline(series, { reliable });
    expect(gated.qualityGated).toBe(true);
    expect(gated.value).toBe(45);
    expect(coebisBaseline(series).value).toBeLessThan(60);
  });

  it("falls back to every value rather than leaving a case without a baseline", () => {
    const series = Array.from({ length: 30 }, () => 50);
    const out = coebisBaseline(series, { reliable: series.map(() => false) });
    expect(out.qualityGated).toBe(false);
    expect(out.value).toBe(50);
  });
});

describe("in-fit share", () => {
  it("reports what actually happened rather than a Gaussian estimate", () => {
    const residuals = [0, 1, 2, 3, 4, 20, 25, -30, 0.5, -1];
    expect(empiricalInFitPercent(residuals)).toBe(70);
    expect(empiricalInFitPercent([1, 2])).toBeNull();
  });
});

describe("spectral preprocessing", () => {
  it("removes a linear trend, not just the mean", () => {
    const seg = Float64Array.from({ length: 8 }, (_, i) => 3 + 2 * i);
    const out = new Float64Array(8);
    detrendInto(seg, out);
    for (const v of out) expect(Math.abs(v)).toBeLessThan(1e-9);
  });

  it("keeps baseline drift out of the delta band", () => {
    const fs = MUSE_SAMPLE_RATE;
    const n = 4 * fs;
    const clean = Float64Array.from({ length: n }, (_, i) =>
      10 * Math.sin((2 * Math.PI * 10 * i) / fs),
    );
    const drifting = Float64Array.from(clean, (v, i) => v + (60 * i) / n);
    const deltaOf = (sig: Float64Array) => {
      const psd = computePsd(sig, fs);
      let sum = 0;
      for (let k = 0; k < psd.freqs.length; k++) {
        if (psd.freqs[k]! >= 0.5 && psd.freqs[k]! < 4) sum += psd.power[k]! * psd.binWidth;
      }
      return sum;
    };
    expect(deltaOf(drifting)).toBeLessThan(deltaOf(clean) * 5 + 1);
  });

  it("identifies which mains frequency the trace actually carries", () => {
    const fs = MUSE_SAMPLE_RATE;
    const n = 4 * fs;
    const make = (hz: number) =>
      Float64Array.from({ length: n }, (_, i) =>
        5 * Math.sin((2 * Math.PI * 9 * i) / fs) + 20 * Math.sin((2 * Math.PI * hz * i) / fs),
      );
    expect(detectMainsHz(computePsd(make(50), fs)).detected).toBe(50);
    expect(detectMainsHz(computePsd(make(60), fs)).detected).toBe(60);
  });
});
