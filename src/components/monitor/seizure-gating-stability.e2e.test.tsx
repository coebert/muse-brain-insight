/**
 * End-to-end: seizure gating stays consistent as the acquisition lineage
 * changes.
 *
 * Switching device profiles mid-case (headband swap, generic ingest, a rate
 * change) must never leave the detector on thresholds carried over from the
 * previous montage. These tests walk long sequences of lineage changes and
 * assert the gate decision (blocked vs allowed) and the applied
 * seizureThreshold / seizureEpochs depend only on the lineage in force — never
 * on the order the lineages were visited, and never drifting on revisit.
 */
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MUSE_2_PROFILE, type DeviceProfile } from "@/lib/eeg/device-profile";
import {
  applySeizureGate,
  gateSeizureDetector,
  lineageKey,
  lineageFromProfile,
} from "@/lib/eeg/model-lineage";
import {
  makeRng,
  profileFromLineage,
  randomLineage,
  seizureGateFixtures,
} from "@/lib/eeg/lineage-fixtures";
import { guardSeizureRuntime } from "@/lib/eeg/runtime-guard";

import { SeizureThresholdPanel } from "./SeizureThresholdPanel";

/** Configured detector settings, as a clinician would leave them. */
const CONFIGURED = { seizureThreshold: 0.55, seizureEpochs: 5 } as const;

interface Applied {
  mode: string;
  allowed: boolean;
  seizureThreshold: number;
  seizureEpochs: number;
}

/** What the detector actually runs with on a given profile. */
function applyFor(profile: DeviceProfile): Applied {
  const gate = gateSeizureDetector(profile);
  const settings = applySeizureGate({ ...CONFIGURED }, gate);
  return {
    mode: gate.mode,
    allowed: gate.allowed,
    seizureThreshold: settings.seizureThreshold,
    seizureEpochs: settings.seizureEpochs,
  };
}

afterEach(cleanup);

describe("seizure gating consistency across lineage changes", () => {
  it("gives the same decision and thresholds however the lineage was reached", () => {
    const profiles = seizureGateFixtures();
    const first = new Map<string, Applied>();
    for (const p of profiles) first.set(lineageKey(lineageFromProfile(p)), applyFor(p));

    // Walk the profiles again in a scrambled order, revisiting each several
    // times, as a case that keeps switching devices would.
    const rng = makeRng(4242);
    for (let i = 0; i < 1500; i += 1) {
      const p = profiles[Math.floor(rng.next() * profiles.length)]!;
      const key = lineageKey(lineageFromProfile(p));
      expect(applyFor(p)).toEqual(first.get(key));
    }
  });

  it("never mutates the configured settings when gating", () => {
    const configured = { ...CONFIGURED };
    for (const p of seizureGateFixtures()) applySeizureGate(configured, gateSeizureDetector(p));
    expect(configured).toEqual(CONFIGURED);
  });

  it("restores the validated thresholds when the lineage returns to Muse 2", () => {
    const rng = makeRng(99);
    for (let i = 0; i < 200; i += 1) {
      // Any detour through a foreign lineage, then back.
      applyFor(profileFromLineage(randomLineage(rng)));
      const back = applyFor(MUSE_2_PROFILE);
      expect(back).toEqual({
        mode: "run",
        allowed: true,
        seizureThreshold: CONFIGURED.seizureThreshold,
        seizureEpochs: CONFIGURED.seizureEpochs,
      });
    }
  });

  it("only ever loosens back to configured values, never below them", () => {
    for (const p of seizureGateFixtures()) {
      const applied = applyFor(p);
      expect(applied.seizureThreshold).toBeGreaterThanOrEqual(CONFIGURED.seizureThreshold);
      expect(applied.seizureEpochs).toBeGreaterThanOrEqual(CONFIGURED.seizureEpochs);
      if (applied.allowed) {
        // A running detector must stay inside a firable range.
        expect(applied.seizureThreshold).toBeLessThanOrEqual(0.95);
      } else {
        // A blocked detector is pinned above the score ceiling.
        expect(applied.seizureThreshold).toBeGreaterThan(1);
      }
    }
  });

  it("keeps the runtime guard aligned with the gate on every lineage", () => {
    // The guard sees the full stored threshold shape, as the monitor hands it.
    const stored = { ...CONFIGURED, suppressionThresholdUv: 10, srWindowSeconds: 120 };
    for (const p of seizureGateFixtures()) {
      const gate = gateSeizureDetector(p);
      const guard = guardSeizureRuntime({ ...stored }, { profile: p, gate });
      expect(guard.status === "blocked").toBe(!gate.allowed);
      if (gate.allowed) {
        expect(guard.status).toBe(gate.mode === "provisional" ? "warn" : "ok");
      }
      // The guard reports the configured values; stiffening is the gate's job,
      // and the two must not disagree about what was configured.
      expect(guard.thresholds?.seizureThreshold).toBe(CONFIGURED.seizureThreshold);
      expect(guard.thresholds?.seizureEpochs).toBe(CONFIGURED.seizureEpochs);
    }
  });

  it("shows the same applied numbers on the panel after switching away and back", () => {
    const foreign = profileFromLineage({
      deviceId: "gen-frontal",
      deviceLabel: "Frontal only",
      transport: "ingest",
      channels: ["AF7", "AF8"],
      sampleRate: 256,
    });

    const readPanel = (profile: DeviceProfile) => {
      const applied = applyFor(profile);
      render(
        <SeizureThresholdPanel
          configured={CONFIGURED}
          applied={applied}
          profile={profile}
        />,
      );
      const panel = screen.getByLabelText("Applied seizure thresholds for this lineage");
      const values = Array.from(panel.querySelectorAll(".metric-value")).map(
        (n) => n.textContent ?? "",
      );
      const text = panel.textContent ?? "";
      cleanup();
      return { values, text };
    };

    const museFirst = readPanel(MUSE_2_PROFILE);
    const away = readPanel(foreign);
    const museAgain = readPanel(MUSE_2_PROFILE);

    expect(museAgain).toEqual(museFirst);
    expect(museFirst.values).toEqual(["0.55", "5"]);
    expect(museFirst.text).toContain("Validated thresholds in force");
    // The reduced montage is stiffened, and says so.
    expect(away.values).not.toEqual(museFirst.values);
    expect(away.text).toContain("configured 0.55 → applied");
  });
});
