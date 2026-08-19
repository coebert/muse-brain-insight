import { describe, expect, it } from "vitest";

import {
  configForLineage,
  parseCoebisModel,
  parseDetectorThresholds,
  parseLineageConfigs,
} from "./model-config-schema";
import { lineageKey, type DataLineage } from "./model-lineage";

const muse: DataLineage = {
  deviceId: "muse-2",
  deviceLabel: "Muse 2",
  transport: "ble",
  channels: ["TP9", "AF7", "AF8", "TP10"],
  sampleRate: 256,
};
const museKey = lineageKey(muse);

const goodThresholds = {
  seizureThreshold: 0.62,
  seizureEpochs: 3,
  suppressionThresholdUv: 8,
  srWindowSeconds: 60,
};

describe("detector thresholds", () => {
  it("accepts the current shape", () => {
    const r = parseDetectorThresholds(goodThresholds);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.seizureEpochs).toBe(3);
  });

  it("rejects legacy field names by default", () => {
    const r = parseDetectorThresholds({
      seizureScoreThreshold: 0.62,
      seizureMinEpochs: 3,
      suppressionThresholdUv: 8,
      srWindowSeconds: 60,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain("seizureThreshold");
  });

  it("migrates legacy names on request, with a warning", () => {
    const r = parseDetectorThresholds(
      {
        seizureScoreThreshold: 0.7,
        seizureMinEpochs: 4,
        suppressionUv: 6,
        srWindow: 30,
      },
      { migrate: true },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        seizureThreshold: 0.7,
        seizureEpochs: 4,
        suppressionThresholdUv: 6,
        srWindowSeconds: 30,
      });
      expect(r.warnings).toHaveLength(4);
    }
  });

  it("rejects unknown keys and out-of-range values", () => {
    expect(parseDetectorThresholds({ ...goodThresholds, wobble: 1 }).ok).toBe(false);
    expect(parseDetectorThresholds({ ...goodThresholds, seizureEpochs: 0 }).ok).toBe(false);
    expect(parseDetectorThresholds({ ...goodThresholds, seizureThreshold: Infinity }).ok).toBe(false);
    expect(parseDetectorThresholds("nope").ok).toBe(false);
  });
});

describe("COEBIS model config", () => {
  const affine = { modelVersion: "coebis-1", modelFamily: "affine", gain: 0.9, offset: 4 };

  it("accepts a bare affine model and defaults the collections", () => {
    const r = parseCoebisModel(affine);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.knots).toEqual([]);
      expect(r.value.lineageKey).toBeNull();
      expect(r.warnings[0]).toContain("no lineage");
    }
  });

  it("rejects a family/coefficient mismatch", () => {
    expect(parseCoebisModel({ ...affine, knots: [{ x: 40, dy: 2 }] }).ok).toBe(false);
    expect(parseCoebisModel({ ...affine, modelFamily: "covariate" }).ok).toBe(false);
    expect(
      parseCoebisModel({
        ...affine,
        modelFamily: "affine-knots",
        knots: [{ x: 40, dy: 2 }],
        terms: [{ group: "age", level: "65+", dy: 2, n: 10 }],
      }).ok,
    ).toBe(false);
  });

  it("rejects duplicate knots and unknown families", () => {
    expect(
      parseCoebisModel({
        ...affine,
        modelFamily: "affine-knots",
        knots: [
          { x: 40, dy: 2 },
          { x: 40, dy: -1 },
        ],
      }).ok,
    ).toBe(false);
    expect(parseCoebisModel({ ...affine, modelFamily: "gaussian-process" }).ok).toBe(false);
  });

  it("rejects an invalid lineage key", () => {
    expect(parseCoebisModel({ ...affine, lineageKey: "muse-2" }).ok).toBe(false);
    const r = parseCoebisModel({ ...affine, lineageKey: museKey });
    expect(r.ok).toBe(true);
  });
});

describe("per-lineage bundle", () => {
  it("keeps valid entries and drops the rest with reasons", () => {
    const parsed = parseLineageConfigs({
      [museKey]: {
        model: { modelVersion: "coebis-2", modelFamily: "affine", gain: 1, offset: 0, lineageKey: museKey },
        thresholds: goodThresholds,
      },
      "not-a-key": { thresholds: goodThresholds },
      "focuscalm|AF7-AF8|64": { thresholds: goodThresholds },
    });
    expect(parsed.configs.map((c) => c.lineageKey)).toEqual([museKey]);
    expect(parsed.rejected).toHaveLength(2);
    expect(parsed.rejected[1]!.issues[0]).toContain("analysis floor");
  });

  it("refuses a model filed under a different lineage", () => {
    const parsed = parseLineageConfigs({
      [museKey]: {
        model: {
          modelVersion: "coebis-2",
          modelFamily: "affine",
          gain: 1,
          offset: 0,
          lineageKey: "focuscalm|AF7-AF8|256",
        },
        thresholds: goodThresholds,
      },
    });
    expect(parsed.configs).toHaveLength(0);
    expect(parsed.rejected[0]!.issues[0]).toContain("does not match");
  });

  it("rejects the whole entry when thresholds carry a legacy shape", () => {
    const legacy = {
      [museKey]: {
        thresholds: { seizureScoreThreshold: 0.6, seizureMinEpochs: 2, suppressionThresholdUv: 8, srWindowSeconds: 60 },
      },
    };
    expect(parseLineageConfigs(legacy).configs).toHaveLength(0);
    const migrated = parseLineageConfigs(legacy, { migrate: true });
    expect(migrated.configs).toHaveLength(1);
    expect(migrated.warnings.some((w) => w.includes("migrated"))).toBe(true);
  });

  it("looks a config up by the live lineage", () => {
    const parsed = parseLineageConfigs({ [museKey]: { thresholds: goodThresholds } });
    expect(configForLineage(parsed, muse)?.lineageKey).toBe(museKey);
    expect(configForLineage(parsed, { ...muse, channels: ["AF7", "AF8"] })).toBeNull();
  });

  it("rejects a non-object bundle", () => {
    expect(parseLineageConfigs([]).rejected[0]!.key).toBe("<root>");
  });
});
