import { describe, expect, it } from "vitest";

import {
  guardInterpretation,
  isTreatmentDirective,
  numberIsSupported,
  type GuardAlert,
  type GuardInput,
} from "./interpret-guard";

const digest = {
  durationSeconds: 1800,
  suppression: { available: true, meanRatioPct: 38.2, maxRatioPct: 61.4 },
  spectral: { meanSef95Hz: 9.4 },
  quality: { usableFraction: 0.92 },
  depthIndex: { reliableFraction: 0.85, latestIsReliable: true, meanWhenReliable: 31 },
};

function alert(over: Partial<GuardAlert> = {}): GuardAlert {
  return {
    id: "deep-suppression",
    severity: "warning",
    category: "burst_suppression",
    title: "Sustained suppression",
    detail: "Suppression ratio is high for this age.",
    action: "Review the suppression trend.",
    confidence: "moderate",
    evidence: [{ feature: "Suppression ratio", value: "38.2 %" }],
    ...over,
  };
}

function base(over: Partial<GuardInput> = {}): GuardInput {
  return {
    headline: "Deep pattern with suppression.",
    alerts: [alert()],
    depthOfAnaesthesia: "Depth index mean 31.",
    burstSuppression: "Mean suppression 38.2%.",
    seizureRisk: "Low.",
    markerCorrelations: [],
    pathologyIndicators: [],
    recommendedChecks: [],
    limitations: [],
    dataQualityCaveat: "",
    ...over,
  };
}

describe("treatment directives", () => {
  it("recognises drug-titration language", () => {
    expect(isTreatmentDirective("Reduce propofol infusion and re-check in 5 min.")).toBe(true);
    expect(isTreatmentDirective("Consider increasing the remifentanil rate.")).toBe(true);
    expect(isTreatmentDirective("Suppression ratio is rising.")).toBe(false);
  });

  it("removes a directive from the alert action and substitutes a neutral review", () => {
    const { output, report } = guardInterpretation(
      base({ alerts: [alert({ action: "Reduce propofol infusion and re-check suppression ratio in 5 min." })] }),
      digest,
    );
    expect(output.alerts[0]!.action).not.toMatch(/propofol/i);
    expect(output.alerts[0]!.action).toMatch(/clinician decision/i);
    expect(report.rules).toContain("treatment-directive");
  });

  it("strips directives from free-text sections too", () => {
    const { output } = guardInterpretation(
      base({ recommendedChecks: ["Lower the sevoflurane MAC.", "Check electrode contact."] }),
      digest,
    );
    expect(output.recommendedChecks).toEqual(["Check electrode contact."]);
  });
});

describe("awareness and diagnosis", () => {
  it("removes awareness claims but keeps an awareness limitation", () => {
    const { output } = guardInterpretation(
      base({
        headline: "Suspected awareness during paralysis. Depth index is high.",
        limitations: ["This montage cannot assess awareness."],
      }),
      digest,
    );
    expect(output.headline).toBe("Depth index is high.");
    expect(output.limitations).toEqual(["This montage cannot assess awareness."]);
  });

  it("removes diagnostic assertions", () => {
    const { output } = guardInterpretation(
      base({ seizureRisk: "This confirms a seizure. Rhythmicity score is elevated." }),
      digest,
    );
    expect(output.seizureRisk).toBe("Rhythmicity score is elevated.");
  });
});

describe("numerical evidence must come from the digest", () => {
  it("accepts rounded and percent-converted values", () => {
    expect(numberIsSupported(38, [38.2])).toBe(true);
    expect(numberIsSupported(92, [0.92])).toBe(true);
    expect(numberIsSupported(55, [38.2, 61.4])).toBe(false);
  });

  it("drops an alert whose only evidence cites an invented number", () => {
    const { output, report } = guardInterpretation(
      base({ alerts: [alert({ evidence: [{ feature: "Suppression ratio", value: "74 %" }] })] }),
      digest,
    );
    expect(output.alerts).toHaveLength(0);
    expect(report.droppedAlerts).toBe(1);
    expect(report.rules).toContain("unverified-number");
  });

  it("drops evidence with no number at all", () => {
    const { output } = guardInterpretation(
      base({
        alerts: [
          alert({
            evidence: [
              { feature: "Suppression ratio", value: "high" },
              { feature: "SEF95", value: "9.4 Hz" },
            ],
          }),
        ],
      }),
      digest,
    );
    expect(output.alerts[0]!.evidence).toEqual([{ feature: "SEF95", value: "9.4 Hz" }]);
  });
});

describe("quality and missingness", () => {
  it("drops suppression alerts when suppression was withheld", () => {
    const withheld = { ...digest, suppression: { available: false, meanRatioPct: null } };
    const { output, report } = guardInterpretation(base(), withheld);
    expect(output.alerts).toHaveLength(0);
    expect(output.burstSuppression).toMatch(/withheld/i);
    expect(report.rules).toContain("suppression-withheld");
  });

  it("does not let a depth alert stand on an unreliable depth index", () => {
    const unreliable = { ...digest, depthIndex: { reliableFraction: 0.3, latestIsReliable: false } };
    const { output } = guardInterpretation(
      base({
        alerts: [
          alert({
            category: "excessive_depth",
            evidence: [{ feature: "Depth index", value: "31" }],
          }),
        ],
      }),
      unreliable,
    );
    expect(output.alerts).toHaveLength(0);
    expect(output.depthOfAnaesthesia).toMatch(/unreliable/i);
  });

  it("caps confidence to low when most of the signal is unusable", () => {
    const poor = { ...digest, quality: { usableFraction: 0.3 } };
    const { output } = guardInterpretation(base(), poor);
    expect(output.alerts[0]!.confidence).toBe("low");
  });
});

describe("explanatory role", () => {
  it("never lets the AI raise a critical alarm", () => {
    const { output } = guardInterpretation(base({ alerts: [alert({ severity: "critical" })] }), digest);
    expect(output.alerts[0]!.severity).toBe("warning");
    expect(output.alerts[0]!["origin"]).toBe("ai_explanatory");
  });

  it("voids any model-reported feedback influence", () => {
    const { output } = guardInterpretation(
      base({ alerts: [alert({ feedbackInfluence: { adjustment: "raised_bar", note: "x" } })] }),
      digest,
    );
    expect(output.alerts[0]!["feedbackInfluence"]).toBeNull();
  });

  it("forces pathology patterns to low confidence", () => {
    const { output } = guardInterpretation(
      base({
        pathologyIndicators: [
          { title: "Generalised slowing", detail: "Delta dominant.", confidence: "high", supporting: [] },
        ],
      }),
      digest,
    );
    expect(output.pathologyIndicators[0]!.confidence).toBe("low");
  });
});
