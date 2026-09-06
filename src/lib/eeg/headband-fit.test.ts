import { describe, expect, it } from "vitest";
import { refitHeadbandLineage, isHeadbandLineage } from "./headband-fit";
import type { CoebisTrainingPoint } from "./coebis-covariates";

function point(session: string, at: number, bis: number, appIndex: number): CoebisTrainingPoint {
  return {
    at,
    bis,
    appIndex,
    reliable: true,
    sessionId: session,
    lineageKey: "muse-2|TP9-AF7-AF8-TP10|256",
  } as unknown as CoebisTrainingPoint;
}

/** Headband index sits ~30 points above the monitor; an affine map fixes it. */
function biasedSet(): CoebisTrainingPoint[] {
  const out: CoebisTrainingPoint[] = [];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 6; i++) {
      const bis = 30 + i * 8 + c;
      out.push(point(`case-${c}`, i * 60, bis, bis + 30));
    }
  }
  return out;
}

describe("headband-only provisional fit", () => {
  it("only claims the headband lineages", () => {
    expect(isHeadbandLineage("muse-2|TP9-AF7-AF8-TP10|256")).toBe(true);
    expect(isHeadbandLineage("regul8|AF7-AF8|256")).toBe(true);
    expect(isHeadbandLineage("vitaldb-snuadc|AF7-AF8|128")).toBe(false);
  });

  it("refuses to fit below the provisional bar", () => {
    const few = biasedSet().slice(0, 5);
    const fit = refitHeadbandLineage("muse-2", few, null);
    expect(fit.promote).toBe(false);
    expect(fit.model).toBeNull();
    expect(fit.reason).toContain("paired readings");
  });

  it("promotes a provisional fit that removes a large offset", () => {
    const fit = refitHeadbandLineage("muse-2", biasedSet(), null);
    expect(fit.folds).toBeGreaterThanOrEqual(2);
    expect(fit.promote).toBe(true);
    expect(fit.provisional).toBe(true);
    expect(fit.after.mae ?? 99).toBeLessThan(fit.before.mae ?? 0);
  });

  it("does not promote when the readings carry no usable signal", () => {
    const noise = biasedSet().map((p, i) => ({ ...p, bis: 50 + ((i * 37) % 11) - 5 }));
    const fit = refitHeadbandLineage("muse-2", noise, null);
    expect(fit.promote === false || (fit.maeGain ?? 0) >= 0.25).toBe(true);
  });
});

describe("deep reading bias", () => {
  /** Mostly light readings with a handful of deep ones the index misses. */
  function skewed(): CoebisTrainingPoint[] {
    const out: CoebisTrainingPoint[] = [];
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 8; i++) out.push(point(`case-${c}`, i * 60, 70 + i, 80 + i * 0.9 + c));
      for (let i = 0; i < 2; i++) out.push(point(`case-${c}`, 600 + i * 60, 30 + i * 4, 62 + i * 2 + c));
    }
    return out;
  }

  it("catches more deep readings than an unweighted fit", () => {
    const flat = refitHeadbandLineage("muse-2", skewed(), null, { deepWeight: 1 });
    const biased = refitHeadbandLineage("muse-2", skewed(), null, { deepWeight: 6 });
    expect(flat.deep).toBeDefined();
    expect(biased.deep!.after.sensitivity ?? 0).toBeGreaterThanOrEqual(
      flat.deep!.after.sensitivity ?? 0,
    );
    expect(biased.deep!.threshold).toBe(40);
  });

  it("reports deep detection before and after on the same readings", () => {
    const fit = refitHeadbandLineage("muse-2", skewed(), null);
    expect(fit.deep!.before.monitorDeep).toBe(fit.deep!.after.monitorDeep);
  });
});
