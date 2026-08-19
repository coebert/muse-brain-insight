/**
 * End-to-end lineage gating.
 *
 * Loads a pooled training set drawn from three different acquisition setups
 * and checks the whole path a reading travels: which readings a COEBIS fit for
 * a given setup is allowed to learn from, whether the resulting model may be
 * applied on another setup, and how the seizure detector's validated
 * thresholds behave as the montage thins.
 */
import { describe, expect, it } from "vitest";

import {
  FOCUSCALM_PROFILE,
  FRONTAL_PAIR_PROFILE,
  MUSE_2_PROFILE,
  SIMULATED_PROFILE,
  type DeviceProfile,
} from "./device-profile";
import { fitAlignment, type BisDriftPoint } from "./bis-drift";
import {
  applySeizureGate,
  gateCoebisModel,
  gateSeizureDetector,
  lineageFromProfile,
  lineageKey,
  selectTrainingForLineage,
  summariseLineages,
} from "./model-lineage";

const museKey = lineageKey(lineageFromProfile(MUSE_2_PROFILE));
const frontalKey = lineageKey(lineageFromProfile(FRONTAL_PAIR_PROFILE));
const singleKey = lineageKey(lineageFromProfile(FOCUSCALM_PROFILE));

type Pooled = BisDriftPoint & { lineageKey: string | null };

/**
 * Paired readings whose app index sits `bias` points above the monitor, so a
 * fit that swallows a foreign lineage is visibly pulled off the true map.
 */
function pool(key: string | null, n: number, bias: number, caseTag: string): Pooled[] {
  return Array.from({ length: n }, (_, i) => {
    const bis = 30 + (i % 10) * 4;
    return {
      at: i * 60,
      bis,
      appIndex: bis + bias,
      sessionId: `${caseTag}-${Math.floor(i / 5)}`,
      reliable: true,
      sqi: 0.9,
      recordedAt: new Date(2026, 0, 1 + i).toISOString(),
      lineageKey: key,
    };
  });
}

const MIXED_POOL: Pooled[] = [
  ...pool(museKey, 20, 6, "muse"),
  ...pool(frontalKey, 15, 6, "frontal"),
  ...pool(singleKey, 15, -18, "single"),
  ...pool(null, 5, 6, "legacy"),
];

describe("training-set selection across lineages", () => {
  it("reports every setup that contributed readings", () => {
    const summary = summariseLineages(MIXED_POOL);
    expect(summary.mixed).toBe(true);
    expect(summary.tallies.map((t) => t.key).sort()).toEqual(
      [museKey, frontalKey, singleKey].sort(),
    );
    expect(summary.unlabelled).toBe(5);
    expect(summary.dominant?.key).toBe(museKey);
  });

  it("excludes single-channel readings from a full-montage fit", () => {
    const { used, excluded, unlabelled } = selectTrainingForLineage(
      MIXED_POOL,
      lineageFromProfile(MUSE_2_PROFILE),
    );
    expect(excluded.every((p) => p.lineageKey === singleKey)).toBe(true);
    expect(excluded).toHaveLength(15);
    // Pre-lineage readings are grandfathered rather than discarded.
    expect(unlabelled).toHaveLength(5);
    expect(used.some((p) => p.lineageKey === singleKey)).toBe(false);
    expect(used.some((p) => p.lineageKey === frontalKey)).toBe(true);
  });

  it("keeps the fit on the true map instead of averaging two measurements", () => {
    const target = lineageFromProfile(MUSE_2_PROFILE);
    const gated = fitAlignment(selectTrainingForLineage(MIXED_POOL, target).used)!;
    const ungated = fitAlignment(MIXED_POOL)!;
    // Compatible readings all sit +6 above the monitor, so the gated fit must
    // subtract about six points; the contaminated pool cannot.
    expect(gated.biasAfter).toBeLessThan(1);
    expect(Math.abs(gated.maeAfter)).toBeLessThan(Math.abs(ungated.maeAfter));
  });

  it("excludes full-montage readings when the target is a single channel", () => {
    const { used, excluded } = selectTrainingForLineage(
      MIXED_POOL,
      lineageFromProfile(FOCUSCALM_PROFILE),
    );
    expect(excluded.length).toBeGreaterThan(0);
    expect(used.some((p) => p.lineageKey === singleKey)).toBe(true);
  });
});

describe("applying a fitted model on another setup", () => {
  const museLineage = lineageFromProfile(MUSE_2_PROFILE);

  it("runs on the setup it was fitted on", () => {
    const gate = gateCoebisModel(museLineage, museLineage);
    expect(gate.mode).toBe("run");
    expect(gate.allowed).toBe(true);
    expect(gate.degraded).toBe(false);
  });

  it("transfers to the same montage on different hardware, flagged provisional", () => {
    const gate = gateCoebisModel(museLineage, lineageFromProfile(SIMULATED_PROFILE));
    expect(gate.allowed).toBe(true);
    expect(gate.comparison.match).toBe("compatible");
    expect(gate.mode).toBe("provisional");
  });

  it("withholds a bilateral model on a single-hemisphere montage", () => {
    const gate = gateCoebisModel(museLineage, lineageFromProfile(FOCUSCALM_PROFILE));
    expect(gate.mode).toBe("blocked");
    expect(gate.allowed).toBe(false);
    expect(gate.comparison.reasons.join(" ")).toMatch(/hemisphere|positions/i);
  });

  it("withholds a model that never recorded its lineage", () => {
    expect(gateCoebisModel(null, museLineage).allowed).toBe(false);
  });

  it("withholds a full-montage model on a frontal-only pair", () => {
    const gate = gateCoebisModel(museLineage, lineageFromProfile(FRONTAL_PAIR_PROFILE));
    expect(gate.mode).toBe("blocked");
  });
});

describe("seizure thresholds across setups", () => {
  const settings = { seizureThreshold: 0.5, seizureEpochs: 2 };

  const cases: [DeviceProfile, "run" | "provisional" | "blocked"][] = [
    [MUSE_2_PROFILE, "run"],
    [SIMULATED_PROFILE, "run"],
    [FRONTAL_PAIR_PROFILE, "provisional"],
    [FOCUSCALM_PROFILE, "blocked"],
  ];

  it.each(cases)("%#: gates by montage", (profile, expected) => {
    expect(gateSeizureDetector(profile).mode).toBe(expected);
  });

  it("leaves validated thresholds untouched on the validated montage", () => {
    expect(applySeizureGate(settings, gateSeizureDetector(MUSE_2_PROFILE))).toEqual(settings);
  });

  it("stiffens the bar on a frontal-only pair", () => {
    const gate = gateSeizureDetector(FRONTAL_PAIR_PROFILE);
    const gated = applySeizureGate(settings, gate);
    expect(gated.seizureThreshold).toBeGreaterThan(settings.seizureThreshold);
    expect(gated.seizureEpochs).toBeGreaterThanOrEqual(settings.seizureEpochs);
    expect(gate.reasons.join(" ")).toMatch(/temporal/i);
  });

  it("makes the detector unfireable when the montage is withheld", () => {
    const gate = gateSeizureDetector(FOCUSCALM_PROFILE);
    expect(gate.allowed).toBe(false);
    expect(applySeizureGate(settings, gate).seizureThreshold).toBeGreaterThan(1);
  });

  it("blocks detection when the device samples below the analysis band", () => {
    const slow: DeviceProfile = { ...MUSE_2_PROFILE, id: "slow", sampleRate: 64 };
    const gate = gateSeizureDetector(slow);
    expect(gate.mode).toBe("blocked");
    expect(applySeizureGate(settings, gate).seizureThreshold).toBeGreaterThan(1);
  });
});
