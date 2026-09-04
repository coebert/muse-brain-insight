import { describe, expect, it } from "vitest";

import { MIN_POINTS, MIN_SESSIONS } from "../bis-drift";
import {
  MAX_PER_CASE,
  planPairing,
  suggestMoments,
  type PairingMoment,
} from "../pairing-worklist";

function moment(at: number, appIndex = 50): PairingMoment {
  return { at, appIndex, appSr: 0, appSef: 12, state: "general" };
}

function candidate(id: string, indexEpochs: number, paired = 0) {
  return {
    sessionId: id,
    caseCode: id,
    startedAt: "2026-01-01T00:00:00Z",
    durationSeconds: indexEpochs * 5,
    epochs: indexEpochs,
    indexEpochs,
    paired,
  };
}

describe("suggestMoments", () => {
  it("returns nothing when there is nothing scored", () => {
    expect(suggestMoments([], 5)).toEqual([]);
    expect(suggestMoments([moment(10)], 0)).toEqual([]);
  });

  it("keeps clear of the settling and removal margins", () => {
    const epochs = Array.from({ length: 100 }, (_, i) => moment(i * 10));
    const picked = suggestMoments(epochs, 5);
    expect(picked).toHaveLength(5);
    expect(picked[0]!.at).toBeGreaterThanOrEqual(49);
    expect(picked[picked.length - 1]!.at).toBeLessThanOrEqual(941);
  });

  it("spreads the picks evenly and never repeats a moment", () => {
    const epochs = Array.from({ length: 60 }, (_, i) => moment(i * 4));
    const picked = suggestMoments(epochs, 6);
    const times = picked.map((m) => m.at);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("returns everything usable when fewer moments exist than asked for", () => {
    expect(suggestMoments([moment(5), moment(10)], 6)).toHaveLength(2);
  });
});

describe("planPairing", () => {
  it("reports the shortfall against the gate", () => {
    const plan = planPairing("muse-2|TP9-AF7-AF8-TP10|256", { validated: 16, cases: 4 }, [
      candidate("a", 900),
    ]);
    expect(plan.shortfallPoints).toBe(MIN_POINTS - 16);
    expect(plan.shortfallCases).toBe(0);
    expect(plan.ready).toBe(false);
  });

  it("marks the lineage ready once both parts of the gate are met", () => {
    const plan = planPairing("k", { validated: MIN_POINTS, cases: MIN_SESSIONS }, [
      candidate("a", 900),
    ]);
    expect(plan.ready).toBe(true);
    expect(plan.candidates.every((c) => c.suggested === 0)).toBe(true);
  });

  it("never asks a single recording for more than the per-case cap", () => {
    const plan = planPairing("k", { validated: 0, cases: 0 }, [
      candidate("a", 900),
      candidate("b", 800),
      candidate("c", 700),
    ]);
    for (const c of plan.candidates) expect(c.suggested).toBeLessThanOrEqual(MAX_PER_CASE);
  });

  it("never asks for more readings in total than the shortfall", () => {
    const plan = planPairing("k", { validated: 24, cases: 4 }, [
      candidate("a", 900),
      candidate("b", 800),
      candidate("c", 700),
    ]);
    const asked = plan.candidates.reduce((sum, c) => sum + c.suggested, 0);
    expect(asked).toBe(plan.shortfallPoints);
  });

  it("skips recordings with no scored epochs", () => {
    const plan = planPairing("k", { validated: 0, cases: 0 }, [candidate("a", 0), candidate("b", 500)]);
    expect(plan.candidates.find((c) => c.sessionId === "a")!.suggested).toBe(0);
    expect(plan.candidates.find((c) => c.sessionId === "b")!.suggested).toBeGreaterThan(0);
  });

  it("ranks the richest recordings first", () => {
    const plan = planPairing("k", { validated: 0, cases: 0 }, [
      candidate("small", 100),
      candidate("large", 900),
    ]);
    expect(plan.candidates[0]!.sessionId).toBe("large");
  });

  it("counts recordings that hold no monitor readings at all", () => {
    const plan = planPairing("k", { validated: 5, cases: 1 }, [
      candidate("a", 500, 5),
      candidate("b", 500, 0),
      candidate("c", 500, 0),
    ]);
    expect(plan.unpairedRecordings).toBe(2);
  });
});

describe("suggestMoments depth spread", () => {
  it("covers the depth range rather than one state", () => {
    const epochs = Array.from({ length: 100 }, (_, i) =>
      moment(i * 10, i < 50 ? 92 : 40 + (i - 50)),
    );
    const picked = suggestMoments(epochs, 5);
    const spread = Math.max(...picked.map((m) => m.appIndex)) - Math.min(...picked.map((m) => m.appIndex));
    expect(spread).toBeGreaterThan(30);
    expect(picked.map((m) => m.at)).toEqual([...picked.map((m) => m.at)].sort((a, b) => a - b));
  });
});
