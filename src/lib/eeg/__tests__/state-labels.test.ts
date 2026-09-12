import { describe, expect, it } from "vitest";

import {
  BASELINE_STATE_MODEL,
  MIN_EPOCHS,
  caseFolds,
  collapseState,
  featuresFrom,
  fitStateModel,
  gradeStateFit,
  scoreState,
  separationOf,
  type StateEpoch,
} from "../state-labels";

const bands = (delta: number, beta: number) => ({
  delta,
  theta: 1,
  alpha: 1,
  beta,
  gamma: beta / 4,
});

function epoch(caseRef: string, i: number, responsive: boolean): StateEpoch {
  const jitter = ((i * 37) % 11) / 40;
  return {
    caseRef,
    atSeconds: i * 4,
    label: responsive ? "awake" : "anaesthetised",
    state: responsive ? "responsive" : "unresponsive",
    features: responsive
      ? featuresFrom(bands(4 + jitter, 6 - jitter), 22 + jitter, 0)
      : featuresFrom(bands(28 + jitter, 1 + jitter), 10 + jitter, 8),
  };
}

function pool(cases = 6, per = 60): StateEpoch[] {
  const out: StateEpoch[] = [];
  for (let c = 0; c < cases; c++) {
    for (let i = 0; i < per; i++) out.push(epoch(`case_${c}`, i, i % 2 === 0));
  }
  return out;
}

describe("collapseState", () => {
  it("keeps only the two clear states", () => {
    expect(collapseState("awake")).toBe("responsive");
    expect(collapseState("emergence")).toBe("responsive");
    expect(collapseState("anaesthetised")).toBe("unresponsive");
    expect(collapseState("burst_suppression")).toBe("unresponsive");
    expect(collapseState("sedated")).toBeNull();
    expect(collapseState(null)).toBeNull();
  });
});

describe("separation", () => {
  it("scores a clean split near one and a coin toss near a half", () => {
    const clean = separationOf(pool(), (f) => scoreState(BASELINE_STATE_MODEL, f));
    expect(clean.auc).toBeGreaterThan(0.9);
    expect(clean.gap).toBeGreaterThan(0);
    expect(clean.cut).not.toBeNull();

    const flat = separationOf(pool(), () => 50);
    expect(flat.auc).toBeCloseTo(0.5, 5);
  });
});

describe("caseFolds", () => {
  it("never puts one case in two folds", () => {
    const folds = caseFolds(pool(6, 10));
    expect(folds.length).toBeGreaterThan(1);
    const seen = new Map<string, number>();
    folds.forEach((fold, i) => {
      for (const p of fold) {
        expect(seen.get(p.caseRef) ?? i).toBe(i);
        seen.set(p.caseRef, i);
      }
    });
  });
});

describe("fitStateModel", () => {
  it("learns the responsive direction and stays bounded", () => {
    const model = fitStateModel(pool());
    expect(model).not.toBeNull();
    expect(model!.w.every((w) => Math.abs(w) <= 3.001)).toBe(true);
    const awake = scoreState(model!, epoch("x", 0, true).features);
    const asleep = scoreState(model!, epoch("x", 1, false).features);
    expect(awake).toBeGreaterThan(asleep);
  });

  it("refuses a single-state pool", () => {
    const single = pool(4, 20).filter((p) => p.state === "responsive");
    expect(fitStateModel(single)).toBeNull();
  });
});

describe("gradeStateFit", () => {
  it("will not fit a pool that is too small to hold anything out", () => {
    const report = gradeStateFit(pool(2, 20));
    expect(report.promote).toBe(false);
    expect(report.model).toBeNull();
    expect(report.reason).toContain(String(MIN_EPOCHS));
  });

  it("grades held out by case and only promotes on a clear gain", () => {
    const report = gradeStateFit(pool());
    expect(report.folds).toBeGreaterThan(1);
    expect(report.after.epochs).toBe(report.epochs);
    if (report.promote) {
      expect(report.after.auc - report.before.auc).toBeGreaterThanOrEqual(0.02);
      expect(report.model).not.toBeNull();
    } else {
      expect(report.model).toBeNull();
    }
  });
});
