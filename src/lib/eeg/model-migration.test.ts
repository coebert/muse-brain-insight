import { describe, expect, it } from "vitest";

import {
  MODEL_CONFIG_VERSION,
  describeMigration,
  migrateDetectorThresholds,
  migrateLegacyFields,
  migrateLineageConfigs,
  migrateSavedModel,
  migrateStoredModelConfigs,
} from "./model-migration";
import { lineageKey } from "./model-lineage";

const museKey = lineageKey({
  deviceId: "muse-2",
  deviceLabel: "Muse 2",
  transport: "ble",
  channels: ["TP9", "AF7", "AF8", "TP10"],
  sampleRate: 256,
});

const legacyThresholds = {
  seizureScoreThreshold: 0.7,
  seizureMinEpochs: 4,
  suppressionUv: 6,
  srWindow: 30,
};

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

describe("legacy field renaming", () => {
  it("renames nested and array-held legacy fields", () => {
    const r = migrateLegacyFields({
      models: [{ thresholds: legacyThresholds }],
      thresholds: { seizureScoreThreshold: 0.5 },
    });
    expect(r.migrated).toBe(true);
    expect(r.value).toEqual({
      models: [
        {
          thresholds: {
            seizureThreshold: 0.7,
            seizureEpochs: 4,
            suppressionThresholdUv: 6,
            srWindowSeconds: 30,
          },
        },
      ],
      thresholds: { seizureThreshold: 0.5 },
    });
    expect(r.changes).toHaveLength(5);
  });

  it("keeps the current name when both are present, and says so", () => {
    const r = migrateLegacyFields({ seizureScoreThreshold: 0.9, seizureThreshold: 0.6 });
    expect(r.value).toEqual({ seizureThreshold: 0.6 });
    expect(r.changes[0]!.conflicted).toBe(true);
    expect(describeMigration(r.changes)).toContain("already set");
  });

  it("leaves an already-current record untouched", () => {
    const current = { seizureThreshold: 0.62, seizureEpochs: 3 };
    const r = migrateLegacyFields(current);
    expect(r.migrated).toBe(false);
    expect(r.value).toEqual(current);
    expect(describeMigration(r.changes)).toBe("no legacy fields found");
  });
});

describe("threshold migration + validation", () => {
  it("upgrades a legacy set into the validated shape", () => {
    const r = migrateDetectorThresholds(legacyThresholds);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        seizureThreshold: 0.7,
        seizureEpochs: 4,
        suppressionThresholdUv: 6,
        srWindowSeconds: 30,
      });
      expect(r.migrated).toBe(true);
    }
  });

  it("still rejects a record that is broken after renaming", () => {
    const r = migrateDetectorThresholds({ ...legacyThresholds, seizureMinEpochs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain("seizureEpochs");
  });
});

describe("bundle and saved-model migration", () => {
  it("migrates a per-lineage bundle before validating it", () => {
    const parsed = migrateLineageConfigs({ [museKey]: { thresholds: legacyThresholds } });
    expect(parsed.configs).toHaveLength(1);
    expect(parsed.configs[0]!.thresholds.seizureEpochs).toBe(4);
    expect(parsed.changes).toHaveLength(4);
  });

  it("stamps the schema version and skips records already at it", () => {
    const first = migrateSavedModel({ thresholds: legacyThresholds });
    expect(first.value["configVersion"]).toBe(MODEL_CONFIG_VERSION);
    expect(first.migrated).toBe(true);
    const second = migrateSavedModel(first.value);
    expect(second.alreadyCurrent).toBe(true);
    expect(second.changes).toHaveLength(0);
  });
});

describe("storage sweep", () => {
  it("rewrites only the records carrying legacy names", () => {
    const store = new MemoryStorage();
    store.setItem("eeg.detection", JSON.stringify(legacyThresholds));
    store.setItem("eeg.current", JSON.stringify({ seizureThreshold: 0.62 }));
    store.setItem("eeg.note", "not json");
    const reports = migrateStoredModelConfigs(store);
    expect(reports.map((r) => r.key)).toEqual(["eeg.detection"]);
    expect(JSON.parse(store.getItem("eeg.detection")!)).toMatchObject({
      seizureThreshold: 0.7,
      seizureEpochs: 4,
    });
    expect(store.getItem("eeg.note")).toBe("not json");
    expect(migrateStoredModelConfigs(store)).toHaveLength(0);
  });
});
