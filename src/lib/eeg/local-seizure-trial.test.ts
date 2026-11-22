import { describe, expect, it } from "vitest";
import fixture from "./synthetic-seizure-features.json";
import {
  decodeSeizureTrialFixture,
  parseSeizureCheckpoint,
  runSeizureTrial,
} from "./local-seizure-trial";

// A hand-built three-node tree. No parameters from the research checkpoints are bundled.
const tree = {
  is_leaf: [0, 1, 1],
  feature_idx: [0, 0, 0],
  num_threshold: [1, 0, 0],
  missing_go_to_left: [1, 0, 0],
  left: [1, 0, 0],
  right: [2, 0, 0],
  value: [0, -1, 1],
};
const reference = {
  version: 1,
  step_seconds: 8,
  columns: 140,
  montage: "frontal",
  baseline: 0,
  trees: [tree],
  calibration: [1, 0],
  policies: {
    lower_alarm: { threshold: 0.65, persistence: 2, release_ratio: 0.6 },
    sensitivity_priority: { threshold: 0.65, persistence: 1 },
  },
};
describe("local seizure research replay", () => {
  it("withholds both windows during the planned electrode loss", () => {
    const rows = decodeSeizureTrialFixture(fixture);
    expect(rows).toHaveLength(24);
    expect(rows.filter(Boolean)).toHaveLength(22);
    expect(rows.slice(18, 20)).toEqual([null, null]);
    expect(rows[0]).toHaveLength(140);
    expect(rows[0]!.some(Number.isNaN)).toBe(true);
    const result = runSeizureTrial(
      parseSeizureCheckpoint(JSON.stringify(reference)),
      rows,
      "lower_alarm",
    );
    expect(result.scores.slice(18, 20)).toEqual([null, null]);
  });
  it("routes missing inputs, applies calibration, timestamps confirmation and resets at loss", () => {
    const row = (v: number) => Array<number>(140).fill(v);
    const rows = [row(NaN), row(2), row(2), null, row(2)];
    const model = parseSeizureCheckpoint(JSON.stringify(reference));
    const r = runSeizureTrial(model, rows, "lower_alarm");
    expect(r.scores[0]).toBeCloseTo(1 / (1 + Math.exp(1)), 12);
    expect(r.scores[1]).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    expect(r.alarms).toEqual([24]);
    expect(runSeizureTrial(model, rows, "sensitivity_priority").alarms).toEqual([16, 40]);
  });
  it("rejects cycles and incompatible montages, widths and intervals", () => {
    for (const changed of [
      { trees: [{ ...tree, left: [0, 0, 0] }] },
      { montage: "broad" },
      { columns: 171 },
      { step_seconds: 4 },
    ]) {
      expect(() => parseSeizureCheckpoint(JSON.stringify({ ...reference, ...changed }))).toThrow();
    }
  });
});
