import { describe, expect, it } from "vitest";

import {
  discoverCovariateFeatures,
  featuresFromBands,
  spearman,
  tTestP,
  type DiscoveryRow,
} from "./covariate-discovery";

function row(
  lineage: string,
  caseRef: string,
  cov: Record<string, string | number | null>,
  opts: { alpha: number; sef: number; sr?: number },
): DiscoveryRow {
  const features = featuresFromBands(
    { delta: 100, theta: 20, alpha: opts.alpha, beta: 5, gamma: 1 },
    126 + opts.alpha,
    opts.sef,
    opts.sr ?? 0,
  )!;
  return { lineage, caseRef, covariates: cov, features };
}

describe("covariate discovery", () => {
  it("recovers a monotone age trend in SEF95 within a lineage", () => {
    const rows: DiscoveryRow[] = [];
    const bands = ["18-39", "40-59", "60-74", "75-89"];
    bands.forEach((band, bi) => {
      for (let c = 0; c < 6; c++) {
        for (let e = 0; e < 30; e++) {
          rows.push(
            row("test:lineage", `${band}-${c}`, { age_band: band, sex: c % 2 ? "M" : "F" }, {
              alpha: 30,
              // SEF falls with age, plus small per-case noise.
              sef: 14 - bi * 1.5 + ((c % 3) - 1) * 0.1,
            }),
          );
        }
      }
    });

    const result = discoverCovariateFeatures(rows);
    expect(result.lineages).toHaveLength(1);
    const lineage = result.lineages[0]!;
    expect(lineage.cases).toBe(24);

    const ageSef = lineage.associations.find((a) => a.group === "age" && a.feature === "sef95");
    expect(ageSef).toBeDefined();
    expect(ageSef!.rho!).toBeLessThan(-0.8);
    expect(ageSef!.significant).toBe(true);
    expect(ageSef!.sufficiency).toBe("sufficient");

    // Sex is unrelated to the signal, so it must not be flagged.
    const sexSef = lineage.associations.find((a) => a.group === "sex" && a.feature === "sef95");
    expect(sexSef?.significant ?? false).toBe(false);
  });

  it("emits a shrunken, capped candidate term for the oldest band", () => {
    const rows: DiscoveryRow[] = [];
    for (const [band, sef] of [
      ["18-39", 15],
      ["75-89", 8],
    ] as const) {
      for (let c = 0; c < 6; c++) {
        for (let e = 0; e < 20; e++) {
          rows.push(row("test:lineage", `${band}-${c}`, { age_band: band }, { alpha: 30, sef }));
        }
      }
    }
    const lineage = discoverCovariateFeatures(rows).lineages[0]!;
    const old = lineage.candidates.find((c) => c.level === "75-89");
    expect(old).toBeDefined();
    expect(old!.dy).toBeLessThan(0);
    expect(Math.abs(old!.dy)).toBeLessThanOrEqual(6);
    expect(old!.shrinkage).toBeLessThan(1);
    expect(old!.status).toBe("candidate");
  });

  it("keeps lineages separate and drops levels with too few cases", () => {
    const rows: DiscoveryRow[] = [];
    for (let c = 0; c < 4; c++) {
      for (let e = 0; e < 20; e++) {
        rows.push(row("a", `a-${c}`, { sex: "M" }, { alpha: 30, sef: 12 }));
        rows.push(row("b", `b-${c}`, { sex: "F" }, { alpha: 30, sef: 9 }));
      }
    }
    // Single-case level: not enough independent cases to test.
    for (let e = 0; e < 20; e++) rows.push(row("a", "a-solo", { sex: "F" }, { alpha: 30, sef: 4 }));

    const result = discoverCovariateFeatures(rows);
    expect(result.lineages.map((l) => l.lineage).sort()).toEqual(["a", "b"]);
    const a = result.lineages.find((l) => l.lineage === "a")!;
    expect(a.associations.some((x) => x.group === "sex")).toBe(false);
  });

  it("normalises percentage suppression ratios and rejects empty spectra", () => {
    const f = featuresFromBands({ delta: 1, theta: 1, alpha: 1, beta: 1, gamma: 1 }, 5, 10, 45)!;
    expect(f.suppressionRatio).toBeCloseTo(0.45, 6);
    expect(f.relDelta).toBeCloseTo(0.2, 6);
    expect(featuresFromBands({}, 0, null, null)).toBeNull();
  });

  it("computes rank correlation and t tail probabilities", () => {
    expect(spearman([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
    expect(spearman([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 6);
    expect(tTestP(0, 10)).toBeCloseTo(1, 6);
    expect(tTestP(10, 30)).toBeLessThan(0.001);
  });
});
