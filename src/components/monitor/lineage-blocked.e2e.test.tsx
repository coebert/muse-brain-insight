/**
 * End-to-end check on what the Signal tab tells the clinician when the active
 * acquisition setup does not match the calibration lineage: COEBIS fitting and
 * seizure gating must both be stated as held off, with a readable reason.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { FOCUSCALM_PROFILE, FRONTAL_PAIR_PROFILE, MUSE_2_PROFILE } from "@/lib/eeg/device-profile";
import {
  applySeizureGate,
  gateSeizureDetector,
  lineageFromProfile,
  lineageKey,
} from "@/lib/eeg/model-lineage";
import { guardSeizureRuntime } from "@/lib/eeg/runtime-guard";

/** Report the server would return: a model fitted on the full Muse montage. */
const museKey = lineageKey(lineageFromProfile(MUSE_2_PROFILE));
const driftReport = {
  analysis: {},
  active: {
    id: "a1",
    gain: 1.05,
    offset: -2,
    knots: [],
    modelVersion: "coebis-3",
    modelFamily: "affine",
    terms: [],
    nPoints: 40,
    nSessions: 6,
    maeBefore: 8,
    maeAfter: 4,
    biasBefore: 6,
    biasAfter: 1,
    autoApplied: true,
    createdAt: new Date().toISOString(),
    note: null,
    lineage: museKey,
    lineageNote: null,
  },
  justApplied: false,
  history: [],
  series: [],
  gate: null as unknown,
  lineages: { tallies: [], total: 0 },
  excludedByLineage: 0,
};

vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => async () => driftReport,
}));
vi.mock("@/lib/eeg/bis-drift.functions", () => ({ getBisDrift: () => driftReport }));

const { AcquisitionLineagePanel } = await import("./AcquisitionLineagePanel");
const { SeizureThresholdPanel } = await import("./SeizureThresholdPanel");

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const settings = {
  seizureThreshold: 0.6,
  seizureEpochs: 3,
  suppressionThresholdUv: 5,
  srWindowSeconds: 60,
};

function signalTab(profile: typeof MUSE_2_PROFILE) {
  const gate = gateSeizureDetector(profile);
  const guard = guardSeizureRuntime(settings, { profile, gate });
  const applied = applySeizureGate(settings, gate);
  return (
    <>
      <AcquisitionLineagePanel profile={profile} />
      <SeizureThresholdPanel
        configured={settings}
        applied={guard.status === "blocked" ? { ...applied, seizureThreshold: 2 } : applied}
        gate={gate}
        guard={guard}
        profile={profile}
      />
    </>
  );
}

describe("Signal tab — incompatible calibration lineage", () => {
  it("states seizure detection is held off on a single-channel setup, with the reason", async () => {
    renderWithQuery(signalTab(FOCUSCALM_PROFILE));

    const seizurePanel = screen.getByLabelText("Applied seizure thresholds for this lineage");
    expect(seizurePanel).toHaveTextContent(/Alerting held off/i);
    expect(seizurePanel).toHaveTextContent(/single channel|hemisphere/i);
    // The applied threshold must be shown as raised beyond the score ceiling.
    expect(seizurePanel).toHaveTextContent("2.00");
    expect(seizurePanel).toHaveTextContent(/configured 0\.60 → applied 2\.00/);
    expect(seizurePanel).toHaveTextContent(/no seizure alert is raised/i);

    const lineagePanel = screen.getByLabelText("Acquisition setup and detector eligibility");
    expect(lineagePanel).toHaveTextContent(/Seizure detection/);
    expect(lineagePanel).toHaveTextContent(/Held off/);
  });

  it("states COEBIS is held off when the fitted model's setup does not transfer", async () => {
    renderWithQuery(signalTab(FOCUSCALM_PROFILE));

    const lineagePanel = screen.getByLabelText("Acquisition setup and detector eligibility");
    await waitFor(() => {
      expect(lineagePanel).toHaveTextContent(/COEBIS depth index/);
    });
    await waitFor(() => {
      expect(lineagePanel.textContent ?? "").toMatch(/held off|Held off/i);
    });
    // A reason and a next step, not just a status chip.
    expect(lineagePanel).toHaveTextContent(/Next:/);
  });

  it("shows a stiffened, not blocked, seizure bar on a frontal-only bilateral setup", () => {
    renderWithQuery(signalTab(FRONTAL_PAIR_PROFILE));

    const seizurePanel = screen.getByLabelText("Applied seizure thresholds for this lineage");
    expect(seizurePanel).toHaveTextContent(/Stiffened thresholds in force/i);
    expect(seizurePanel).toHaveTextContent(/temporal/i);
    expect(seizurePanel).not.toHaveTextContent("2.00");
  });

  it("reports validated thresholds unchanged on the calibration montage", () => {
    renderWithQuery(signalTab(MUSE_2_PROFILE));

    const seizurePanel = screen.getByLabelText("Applied seizure thresholds for this lineage");
    expect(seizurePanel).toHaveTextContent(/Validated thresholds in force/i);
    expect(seizurePanel).toHaveTextContent(/unchanged from configured value/);
  });
});
