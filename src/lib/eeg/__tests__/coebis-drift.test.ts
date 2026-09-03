import { describe, expect, it } from "vitest";

import { driftOverview, lineageDrift } from "../coebis-drift";
import type { LineageHistory, ModelVersionRow } from "../coebis-refit.functions";

function version(partial: Partial<ModelVersionRow> & { version: number }): ModelVersionRow {
  return {
    id: `v${partial.version}`,
    lineageKey: "muse-2|TP9-AF7-AF8-TP10|256",
    modelFamily: "covariate",
    promoted: true,
    isActive: false,
    reason: null,
    maeGain: null,
    createdAt: "2026-01-01T00:00:00Z",
    runId: null,
    dataDigest: `d${partial.version}`,
    coefficients: { gain: 1, offset: 0 },
    training: { n: 40, cases: 4 },
    before: {},
    after: { mae: 5, bias: 0, ccc: 0.9 },
    ...partial,
  } as ModelVersionRow;
}

function history(versions: ModelVersionRow[]): LineageHistory {
  return {
    lineageKey: "muse-2|TP9-AF7-AF8-TP10|256",
    activeVersion: versions.find((v) => v.isActive)?.version ?? null,
    versions,
    latest: versions[0] ?? null,
  };
}

describe("coebis drift", () => {
  it("reports baseline-only when a lineage has one fit", () => {
    const d = lineageDrift(history([version({ version: 1, isActive: true })]));
    expect(d.status).toBe("baseline");
    expect(d.refits).toBe(0);
    expect(d.maeDelta).toBeNull();
  });

  it("calls a close fit stable", () => {
    const d = lineageDrift(
      history([
        version({ version: 2, isActive: true, after: { mae: 4.9, bias: 0.1, ccc: 0.91 } }),
        version({ version: 1 }),
      ]),
    );
    expect(d.status).toBe("stable");
    expect(d.maeDelta).toBeCloseTo(-0.1, 5);
  });

  it("flags a held-out regression against the original fit", () => {
    const d = lineageDrift(
      history([
        version({ version: 2, isActive: true, after: { mae: 6.4, bias: 1, ccc: 0.8 } }),
        version({ version: 1 }),
      ]),
    );
    expect(d.status).toBe("regressed");
    expect(d.maeDelta).toBeCloseTo(1.4, 5);
  });

  it("flags large weight movement even when error holds", () => {
    const d = lineageDrift(
      history([
        version({
          version: 2,
          isActive: true,
          coefficients: { gain: 1, offset: 9 },
          after: { mae: 5, bias: 0, ccc: 0.9 },
        }),
        version({ version: 1 }),
      ]),
    );
    expect(d.status).toBe("drifted");
    expect(d.maxWeightDrift).toBeGreaterThanOrEqual(4);
    expect(d.topMovers[0]?.delta).toBeCloseTo(9, 5);
  });

  it("orders lineages worst-first", () => {
    const stable = history([
      version({ version: 2, isActive: true }),
      version({ version: 1 }),
    ]);
    const bad: LineageHistory = {
      ...history([
        version({ version: 2, isActive: true, after: { mae: 9, bias: 2, ccc: 0.5 } }),
        version({ version: 1 }),
      ]),
      lineageKey: "unlabelled",
    };
    const rows = driftOverview([stable, bad]);
    expect(rows[0]?.status).toBe("regressed");
  });
});
