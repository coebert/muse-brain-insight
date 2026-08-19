/**
 * Stress the lineage compatibility rules with randomised and exhaustive
 * fixtures, rather than only the montages someone thought to write down.
 */
import { describe, expect, it } from "vitest";

import { ANALYSIS_CHANNELS } from "./device-profile";
import {
  exhaustiveMontageFixtures,
  expectedMatch,
  generateLineageFixtures,
  makeRng,
  profileFromLineage,
  randomLineage,
  seizureGateFixtures,
  UNUSABLE_RATES,
} from "./lineage-fixtures";
import {
  applySeizureGate,
  compareLineage,
  gateCoebisModel,
  gateSeizureDetector,
  lineageFromProfile,
  MIN_USABLE_SAMPLE_RATE,
} from "./model-lineage";

const SETTINGS = {
  seizureThreshold: 0.6,
  seizureEpochs: 3,
  suppressionThresholdUv: 5,
  srWindowSeconds: 60,
};

describe("lineage fixture generator", () => {
  it("is reproducible for a given seed and varies across seeds", () => {
    const a = generateLineageFixtures(50, 42);
    const b = generateLineageFixtures(50, 42);
    const c = generateLineageFixtures(50, 43);
    expect(a.map((f) => f.name + JSON.stringify(f.current))).toEqual(
      b.map((f) => f.name + JSON.stringify(f.current)),
    );
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c));
  });

  it("produces both workable and broken pairs", () => {
    const fixtures = generateLineageFixtures(400, 7);
    const usable = fixtures.filter((f) => f.coebisUsable).length;
    expect(usable).toBeGreaterThan(40);
    expect(fixtures.length - usable).toBeGreaterThan(40);
    const kinds = new Set(fixtures.map((f) => f.expected));
    expect(kinds).toContain("incompatible");
    expect(kinds).toContain("reduced");
    expect(kinds.has("exact") || kinds.has("compatible")).toBe(true);
  });
});

describe("compareLineage against randomised fixtures", () => {
  it("agrees with the clinical rules on 800 random pairs", () => {
    for (const f of generateLineageFixtures(800, 20260819)) {
      const actual = compareLineage(f.fitted, f.current).match;
      expect(`${f.name}:${actual}`).toBe(`${f.name}:${f.expected}`);
    }
  });

  it("agrees on every montage pair, same device and rate", () => {
    for (const f of exhaustiveMontageFixtures()) {
      expect(`${f.name}:${compareLineage(f.fitted, f.current).match}`).toBe(
        `${f.name}:${f.expected}`,
      );
    }
  });

  it("agrees on every montage pair across different hardware and rates", () => {
    for (const f of exhaustiveMontageFixtures({
      sameDevice: false,
      fittedRate: 256,
      currentRate: 250,
    })) {
      expect(`${f.name}:${compareLineage(f.fitted, f.current).match}`).toBe(
        `${f.name}:${f.expected}`,
      );
    }
  });

  it("never returns a workable match below the usable sample rate", () => {
    const rng = makeRng(99);
    for (let i = 0; i < 200; i += 1) {
      const fitted = randomLineage(rng);
      const current = randomLineage(rng, { channels: fitted.channels, usableRate: false });
      expect(current.sampleRate).toBeLessThan(MIN_USABLE_SAMPLE_RATE);
      expect(compareLineage(fitted, current).match).toBe("incompatible");
    }
  });

  it("always explains itself", () => {
    for (const f of generateLineageFixtures(200, 5)) {
      const c = compareLineage(f.fitted, f.current);
      expect(c.headline.length).toBeGreaterThan(0);
      expect(c.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("COEBIS gating under fixture stress", () => {
  it("blocks exactly the pairs the rules call unworkable, always with an action", () => {
    for (const f of generateLineageFixtures(600, 11)) {
      const gate = gateCoebisModel(f.fitted, f.current);
      expect(`${f.name}:${gate.allowed}`).toBe(`${f.name}:${f.coebisUsable}`);
      expect(gate.mode === "blocked").toBe(!f.coebisUsable);
      expect(gate.action.length).toBeGreaterThan(0);
      if (gate.mode === "provisional") expect(gate.degraded).toBe(true);
      if (gate.mode === "run") expect(gate.comparison.match).toBe("exact");
    }
  });

  it("blocks whenever the model records no lineage", () => {
    const rng = makeRng(3);
    for (let i = 0; i < 50; i += 1) {
      const gate = gateCoebisModel(null, randomLineage(rng));
      expect(gate.mode).toBe("blocked");
      expect(gate.allowed).toBe(false);
    }
  });
});

describe("seizure gating under fixture stress", () => {
  it("never loosens the validated thresholds, whatever the montage", () => {
    for (const profile of seizureGateFixtures()) {
      const gate = gateSeizureDetector(profile);
      const applied = applySeizureGate(SETTINGS, gate);
      expect(gate.thresholdDelta).toBeGreaterThanOrEqual(0);
      expect(gate.extraEpochs).toBeGreaterThanOrEqual(0);
      expect(applied.seizureThreshold).toBeGreaterThanOrEqual(SETTINGS.seizureThreshold);
      expect(applied.seizureEpochs).toBeGreaterThanOrEqual(SETTINGS.seizureEpochs);
      // Untouched detector settings pass through unchanged.
      expect(applied.suppressionThresholdUv).toBe(SETTINGS.suppressionThresholdUv);
      expect(applied.srWindowSeconds).toBe(SETTINGS.srWindowSeconds);
    }
  });

  it("blocks alerting below the usable sample rate on every montage", () => {
    for (const profile of seizureGateFixtures()) {
      if (profile.sampleRate >= MIN_USABLE_SAMPLE_RATE) continue;
      const gate = gateSeizureDetector(profile);
      expect(gate.mode).toBe("blocked");
      expect(gate.allowed).toBe(false);
      expect(gate.reasons.join(" ")).toMatch(/Hz/);
    }
  });

  it("blocks alerting on a single-channel montage and runs on the full one", () => {
    const single = profileFromLineage({
      deviceId: "one-ch",
      deviceLabel: "one channel",
      transport: "ingest",
      channels: ["AF7"],
      sampleRate: 256,
    });
    expect(gateSeizureDetector(single).allowed).toBe(false);

    const full = profileFromLineage({
      deviceId: "muse-2",
      deviceLabel: "full montage",
      transport: "ble",
      channels: [...ANALYSIS_CHANNELS],
      sampleRate: 256,
    });
    const fullGate = gateSeizureDetector(full);
    expect(fullGate.mode).toBe("run");
    expect(applySeizureGate(SETTINGS, fullGate).seizureThreshold).toBe(SETTINGS.seizureThreshold);
  });

  it("stiffens more as temporal coverage is lost", () => {
    const rate = 256;
    const mk = (channels: (typeof ANALYSIS_CHANNELS)[number][]) =>
      gateSeizureDetector(
        profileFromLineage({
          deviceId: "gen",
          deviceLabel: "gen",
          transport: "ingest",
          channels,
          sampleRate: rate,
        }),
      );
    const full = mk([...ANALYSIS_CHANNELS]);
    const oneTemporal = mk(["TP9", "AF7", "AF8"]);
    const noTemporal = mk(["AF7", "AF8"]);
    expect(full.thresholdDelta).toBeLessThanOrEqual(oneTemporal.thresholdDelta);
    expect(oneTemporal.thresholdDelta).toBeLessThanOrEqual(noTemporal.thresholdDelta);
    expect(noTemporal.extraEpochs).toBeGreaterThanOrEqual(oneTemporal.extraEpochs);
  });

  it("keeps the fixture oracle honest for the unusable rates it advertises", () => {
    for (const rate of UNUSABLE_RATES) {
      const l = { channels: [...ANALYSIS_CHANNELS], sampleRate: rate } as const;
      expect(
        expectedMatch(
          { deviceId: "a", deviceLabel: "a", transport: "ingest", ...l },
          { deviceId: "a", deviceLabel: "a", transport: "ingest", ...l },
        ),
      ).toBe("incompatible");
      expect(
        lineageFromProfile(
          profileFromLineage({
            deviceId: "a",
            deviceLabel: "a",
            transport: "ingest",
            ...l,
          }),
        ).sampleRate,
      ).toBe(rate);
    }
  });
});
