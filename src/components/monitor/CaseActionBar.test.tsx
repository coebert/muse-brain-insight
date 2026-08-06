import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { CaseActionBar } from "./CaseActionBar";
import type { CaseControls } from "./case-controls";
import { DEFAULT_SETTINGS } from "@/lib/eeg/analysis";
import { DEFAULT_DEPTH_WINDOW } from "@/hooks/useDepthWindowAlerts";

function controlsStub(overrides: Partial<CaseControls> = {}): CaseControls {
  return {
    running: true,
    elapsed: 300,
    mode: "anaesthesia",
    onMark: vi.fn(),
    markers: [],
    events: [],
    infusions: [],
    onInfusionsChange: vi.fn(),
    bisReadings: [],
    onBisReadingsChange: vi.fn(),
    settings: DEFAULT_SETTINGS,
    onSettingsChange: vi.fn(),
    limitsOffDefault: false,
    onResetLimits: vi.fn(),
    depthWindow: {
      prefs: DEFAULT_DEPTH_WINDOW,
      setPrefs: vi.fn(),
      status: "in",
      breachSeconds: 0,
    },
    sqi: { threshold: 40, setThreshold: vi.fn() },
    alarms: {
      alarms: [],
      unacknowledged: [],
      audioEnabled: true,
      muted: false,
      muteRemaining: 0,
      acknowledge: vi.fn(),
      acknowledgeAll: vi.fn(),
      acknowledgeSide: vi.fn(),
      unacknowledge: vi.fn(),
      pauseAudio: vi.fn(),
      resumeAudio: vi.fn(),
      setAudioEnabled: vi.fn(),
    },
    dim: false,
    onDimChange: vi.fn(),
    handover: [{ label: "Case time", value: "05:00" }],
    live: { depthIndex: 48, suppressionRatio: 0, seizureScore: 0.1, sqi: 88 },
    ...overrides,
  };
}

describe("CaseActionBar", () => {
  it("offers every live-case action in one reach", () => {
    render(<CaseActionBar controls={controlsStub()} />);
    for (const label of ["Mark", "TCI", "Limits", "Alarms", "Log"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("opens the mark sheet without leaving the monitor", () => {
    render(<CaseActionBar controls={controlsStub()} />);
    fireEvent.click(screen.getByRole("button", { name: /Mark/ }));
    expect(screen.getByText("Mark event")).toBeInTheDocument();
  });

  it("flags limits that have been moved off the mode defaults", () => {
    render(<CaseActionBar controls={controlsStub({ limitsOffDefault: true })} />);
    expect(screen.getByRole("button", { name: /Limits/ })).toHaveTextContent("!");
  });

  it("shows the handover summary in the log sheet", () => {
    render(<CaseActionBar controls={controlsStub()} open="log" onOpenChange={vi.fn()} />);
    expect(screen.getByText("Case time")).toBeInTheDocument();
    expect(screen.getByText("05:00")).toBeInTheDocument();
  });
});
