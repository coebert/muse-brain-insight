/**
 * Component-boundary regressions for the descriptor-only policy.
 *
 * The neuromuscular-blockade work showed that an awake, paralysed volunteer
 * reads as sedated. These tests render the real display components — not the
 * policy helpers — with a stale depth excursion, a live COEBIS reading or a
 * cached interpretation, and assert that nothing depth-like reaches the screen
 * when the descriptor verdict is missing. Each case also renders an explicitly
 * eligible control (descriptorOnly={false}) to prove the gate is not blanket.
 */

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiInsightPanel } from "./AiInsightPanel";
import { CoebisV2LivePanel } from "./CoebisV2LivePanel";
import { CoebisVsBisPanel } from "./CoebisVsBisPanel";
import { DepthWindowPanel } from "./DepthWindowPanel";
import { MetricsGrid } from "./MetricsGrid";
import { DEFAULT_DEPTH_WINDOW } from "@/hooks/useDepthWindowAlerts";
import type { Epoch } from "@/lib/eeg/analysis";
import { MUSE_2_PROFILE } from "@/lib/eeg/device-profile";
import {
  DESCRIPTOR_ONLY_TEMPLATES,
  RESEARCH_SCORE_LABEL,
  descriptorPolicy,
} from "@/lib/eeg/descriptor-only";
import type { Interpretation } from "@/lib/eeg/interpret.functions";
import type { CoebisV2DeviceSetup, LiveCoebisV2Reading } from "@/lib/eeg/coebis-v2-device";

vi.mock("@/hooks/useCoebisModel", () => ({
  useCoebisModel: () => null,
  describeCoebisModel: () => "pooled fit",
  coebisFitHint: () => "fit in force",
}));
vi.mock("@/hooks/useSefAlignment", () => ({ useSefAlignment: () => null }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/eeg/alert-feedback.functions", () => ({ submitAlertFeedback: vi.fn() }));
vi.mock("@/lib/eeg/alert-actions.functions", () => ({
  ESCALATION_ROLES: [],
  OVERRIDE_STANCES: [],
  listAlertActions: vi.fn(async () => []),
  recordAlertAction: vi.fn(async () => ({})),
}));

/** A confirmed excursion that predates the descriptor policy. */
const staleWindow = {
  prefs: { ...DEFAULT_DEPTH_WINDOW, enabled: true, low: 40, high: 60 },
  setPrefs: vi.fn(),
  status: "below" as const,
  breachSeconds: 180,
};

/** An epoch that would read as a valid, light-looking depth number. */
const staleEpoch = {
  t: 120,
  sef95: 12.4,
  sef95Raw: 12.9,
  amplitudeUv: 34,
  artifact: false,
  entropy: { state: 0.62, response: 0.71, se95: 0.58, shannon: 0.74 },
  ratios: { deltaAlpha: 1.8, thetaAlpha: 1.1, betaAlpha: 0.42 },
  composite: {
    cIndex: 47,
    cBand: "surgical" as const,
    nIndex: 38,
    nBand: "adequate" as const,
    withheldReason: null,
    held: false,
  },
  suppressionRatio: 4,
  suppressionAvailable: true,
  seizureScore: 0.12,
  seizureAvailable: true,
  confidence: { depth: 0.8, suppression: 0.9, seizure: 0.7, spectral: 0.85 },
  depthReliability: { reliable: true, level: "ok" as const, reasons: [] },
  depth: {
    index: 23,
    coebis: 25,
    held: false,
    heldSeconds: 0,
    gateReasons: [],
    state: "surgical" as const,
  },
} as unknown as Epoch;

const liveReading = {
  status: "available",
  index: 41,
  instant: 41,
  suppressionRatio: 6,
  terms: null,
  drivers: [{ term: "betaRatio", contribution: 3.2 }],
  withheldReason: null,
  researchFeatures: { relAlpha: 0.21 },
  applicability: "fitted",
  amplitudeCalibrated: true,
  bandTuned: false,
  modelVersion: "coebis-v2|test|2026-01-01",
} as unknown as LiveCoebisV2Reading;

const deviceSetup = {
  channels: ["AF7", "AF8"],
  excluded: [],
  applicability: "fitted",
  amplitudeCalibrated: true,
  withheldReason: null,
  caveats: ["Research reading only."],
  verdict: "fitted to this band",
} as unknown as CoebisV2DeviceSetup;

/** A cached review written before descriptor-only existed. */
const staleInterpretation = {
  headline: "Depth adequate at 47; the patient is unconscious and well sedated.",
  alerts: [
    {
      id: "deep",
      severity: "warning",
      category: "excessive_depth",
      title: "Deep anaesthesia",
      detail: "Depth index 32 for 4 min.",
      action: "Reduce the propofol infusion.",
      confidence: "high",
      tSeconds: 120,
      evidence: [{ feature: "Depth index", value: "32" }],
    },
  ],
  depthOfAnaesthesia: "The patient is unconscious and adequately sedated.",
  burstSuppression: "None observed.",
  seizureRisk: "Low.",
  markerCorrelations: ["Depth fell after the bolus at 3 min."],
  pathologyIndicators: [],
  recommendedChecks: ["Reduce the propofol rate."],
  limitations: [],
  dataQualityCaveat: "",
} as unknown as Interpretation;

const gridSummary = { maxSr: null, suppressionSeconds: null, seizureAlerts: null };

/** Current case/interval evidence that supports an experimental descriptor. */
const eligibleEvidence = {
  durationSeconds: 1800,
  researchContext: {
    blockade: "reported-absent",
    caseId: "case-1",
    acquiredAt: "2026-11-21T12:00:00Z",
    reference: "mastoid",
    absenceDocumented: true,
    montageCompatible: true,
    referenceCompatible: true,
    calibrationCompatible: true,
    coverageAdequate: true,
    status: "research score",
  },
};
const eligibleKey = descriptorPolicy(eligibleEvidence).evidenceKey!;

describe("DepthWindowPanel", () => {
  it("withholds a stale breach and the target window when the verdict is omitted", () => {
    render(<DepthWindowPanel depthWindow={staleWindow} depthIndex={22} />);

    expect(screen.getByText("Depth target and alerts withheld")).toBeInTheDocument();
    expect(screen.queryByText(/possible excessive hypnotic depth/i)).toBeNull();
    expect(screen.queryByText(/awareness/i)).toBeNull();
    expect(screen.queryByText(/40–60/)).toBeNull();
    expect(screen.queryByText(/22/)).toBeNull();
  });

  it("still shows the breach and target for an eligible control", () => {
    render(<DepthWindowPanel depthWindow={staleWindow} depthIndex={22} descriptorOnly={false} />);

    expect(screen.getByText(/Depth index below target window/)).toBeInTheDocument();
    expect(screen.getByText(/possible excessive hypnotic depth/i)).toBeInTheDocument();
    expect(screen.queryByText("Depth target and alerts withheld")).toBeNull();
  });
});

describe("MetricsGrid", () => {
  const props = {
    latest: staleEpoch,
    summary: gridSummary,
    srWindowSeconds: 60,
    srTone: "default" as const,
    seizureAlert: false,
    icuMode: false,
    depthWindow: { status: "below" as const, prefs: DEFAULT_DEPTH_WINDOW },
  };

  it("withholds the depth and COEBIS tiles when the verdict is omitted", () => {
    render(<MetricsGrid {...props} />);

    expect(screen.getByText("Depth index (withheld)")).toBeInTheDocument();
    expect(screen.getByText("COEBIS (withheld)")).toBeInTheDocument();
    expect(screen.queryByText("23")).toBeNull();
    expect(screen.queryByText("25")).toBeNull();
  });

  it("shows the tiles for an eligible control", () => {
    render(<MetricsGrid {...props} descriptorOnly={false} />);

    expect(screen.getByText("Depth index (OpenIBIS)")).toBeInTheDocument();
    expect(screen.getByText("23")).toBeInTheDocument();
    expect(screen.queryByText("Depth index (withheld)")).toBeNull();
  });
});

describe("CoebisV2LivePanel", () => {
  const props = { reading: liveReading, setup: deviceSetup, profile: MUSE_2_PROFILE };

  it("withholds the live reading when the verdict is omitted", () => {
    render(<CoebisV2LivePanel {...props} />);

    expect(screen.getByText(/Rebuilt depth index withheld/)).toBeInTheDocument();
    expect(screen.queryByText("41")).toBeNull();
    expect(screen.queryByText(/What is driving this reading/)).toBeNull();
  });

  it("shows the reading for an eligible control", () => {
    render(<CoebisV2LivePanel {...props} descriptorOnly={false} />);

    expect(screen.getByText("41")).toBeInTheDocument();
    expect(screen.queryByText(/Rebuilt depth index withheld/)).toBeNull();
  });
});

describe("CoebisVsBisPanel", () => {
  const props = {
    epochs: [staleEpoch],
    readings: [],
    openIbis: 33,
    model: null,
    covariates: null,
  };

  it("withholds the patient-adjusted comparison when the verdict is omitted", () => {
    render(<CoebisVsBisPanel {...props} />);

    expect(screen.getByText("COEBIS vs commercial BIS withheld")).toBeInTheDocument();
    expect(screen.queryByText("33")).toBeNull();
  });

  it("renders the comparison for an eligible control", () => {
    render(<CoebisVsBisPanel {...props} descriptorOnly={false} />);

    expect(screen.getByText("COEBIS vs commercial BIS")).toBeInTheDocument();
    expect(screen.queryByText("COEBIS vs commercial BIS withheld")).toBeNull();
  });
});

describe("AiInsightPanel", () => {
  const props = {
    loading: false,
    error: null,
    epochCount: 120,
    onRun: vi.fn(),
  };
  // The alert action log reads through react-query.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );

  it("replaces a stale cached interpretation when the verdict is omitted", () => {
    render(<AiInsightPanel {...props} result={staleInterpretation} />, { wrapper });

    expect(screen.getByText(DESCRIPTOR_ONLY_TEMPLATES.headline)).toBeInTheDocument();
    expect(screen.getByText(RESEARCH_SCORE_LABEL, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/unconscious/i)).toBeNull();
    expect(screen.queryByText(/well sedated/i)).toBeNull();
    expect(screen.queryByText(/Deep anaesthesia/)).toBeNull();
    expect(screen.getByText(/No actionable alerts raised from this review/)).toBeInTheDocument();
  });

  it("keeps a review only while its evidence fingerprint matches the current case", () => {
    render(
      <AiInsightPanel
        {...props}
        evidence={eligibleEvidence}
        result={{
          ...staleInterpretation,
          alerts: [],
          descriptorOnly: false,
          descriptorEvidenceKey: eligibleKey,
          headline: "Depth index trended from 42 to 38 over the case.",
        }}
      />,
      { wrapper },
    );

    expect(
      screen.getByText("Depth index trended from 42 to 38 over the case."),
    ).toBeInTheDocument();
    expect(screen.queryByText(DESCRIPTOR_ONLY_TEMPLATES.headline)).toBeNull();
  });

  it("withholds an explicitly eligible cached claim when no current evidence exists", () => {
    render(
      <AiInsightPanel
        {...props}
        result={{
          ...staleInterpretation,
          alerts: [],
          descriptorOnly: false,
          descriptorEvidenceKey: eligibleKey,
          headline: "The patient is unconscious.",
        }}
      />,
      { wrapper },
    );

    expect(screen.getByText(DESCRIPTOR_ONLY_TEMPLATES.headline)).toBeInTheDocument();
    expect(screen.queryByText(/unconscious/i)).toBeNull();
  });

  it("withholds an explicitly eligible cached claim when the evidence changed", () => {
    render(
      <AiInsightPanel
        {...props}
        evidence={{
          ...eligibleEvidence,
          researchContext: { ...eligibleEvidence.researchContext, caseId: "case-2" },
        }}
        result={{
          ...staleInterpretation,
          alerts: [],
          descriptorOnly: false,
          descriptorEvidenceKey: eligibleKey,
          headline: "The patient is unconscious.",
        }}
      />,
      { wrapper },
    );

    expect(screen.getByText(DESCRIPTOR_ONLY_TEMPLATES.headline)).toBeInTheDocument();
    expect(screen.queryByText(/unconscious/i)).toBeNull();
  });
});
