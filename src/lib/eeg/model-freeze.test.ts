import { afterEach, describe, expect, it } from "vitest";

import {
  currentModelProvenance,
  deferWhileFrozen,
  freezeModels,
  isModelFrozen,
  pendingModelChanges,
  releaseModels,
} from "./model-freeze";

const snapshot = {
  coebisAlignment: { id: "a1", version: 3 },
  sefAlignment: null,
  coebisV2: "coebis-v2:vitaldb-snuadc|AF7-AF8|128",
  sedationTune: null,
  amplitudeCalibrated: true,
  withheld: [],
};

afterEach(() => {
  releaseModels();
});

describe("recording model freeze", () => {
  it("applies a model change at once when no recording is running", () => {
    let active = "v1";
    const deferred = deferWhileFrozen("coebis-alignment", () => (active = "v2"));
    expect(deferred).toBe(false);
    expect(active).toBe("v2");
  });

  it("holds a refit that lands mid-recording until the recording ends", () => {
    let active = "v1";
    freezeModels(snapshot);
    expect(isModelFrozen()).toBe(true);
    const deferred = deferWhileFrozen("coebis-alignment", () => (active = "v2"));
    expect(deferred).toBe(true);
    expect(active).toBe("v1");
    expect(pendingModelChanges()).toEqual(["coebis-alignment"]);
    const final = releaseModels();
    expect(active).toBe("v2");
    expect(final?.deferredChanges).toEqual(["coebis-alignment"]);
    expect(final?.releasedAt).not.toBeNull();
  });

  it("keeps only the latest queued change per model", () => {
    let active = "v1";
    freezeModels(snapshot);
    deferWhileFrozen("sef-alignment", () => (active = "v2"));
    deferWhileFrozen("sef-alignment", () => (active = "v3"));
    releaseModels();
    expect(active).toBe("v3");
  });

  it("records the models in force at the start, and a second freeze does not overwrite them", () => {
    freezeModels(snapshot);
    freezeModels({ ...snapshot, coebisAlignment: { id: "b9" } });
    expect(currentModelProvenance()?.coebisAlignment?.id).toBe("a1");
    expect(currentModelProvenance()?.coebisV2).toBe(snapshot.coebisV2);
  });
});
