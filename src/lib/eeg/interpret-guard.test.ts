import { describe, expect, it } from "vitest";

import {
  guardInterpretation,
  isTreatmentDirective,
  numberIsSupported,
  type GuardAlert,
  type GuardInput,
} from "./interpret-guard";

// A fully evidenced context keeps the non-descriptor guard paths under test.
// Absent/unknown contexts are covered in descriptor-only.test.ts.
const researchContext = {
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
};

const digest = {
  durationSeconds: 1800,
  researchContext,
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

describe("treatment directives vs descriptions", () => {
  it.each([
    "Lower the sevoflurane MAC.",
    "Deepen anaesthesia now.",
    "Please give a bolus of propofol.",
    "We recommend reducing the propofol infusion.",
    "The propofol infusion should be reduced.",
    "Increasing the remifentanil rate may help.",
    "A reduction in propofol is recommended.",
    "It may be worth lightening the anaesthetic.",
    "If suppression persists, reduce the propofol infusion.",
    "If suppression persists reduce the propofol infusion.",
    "If BIS < 40, reduce propofol infusion.",
    "When suppression rises, lower sevoflurane.",
    "Reduce the rate of propofol.",
    "Reduce the rate of the propofol infusion.",
    "Suppression is high; reduce the propofol infusion.",
    "Re-check in 5 min and reduce the propofol infusion if it persists.",
    "Give 20 mg of propofol.",
    "Reduce the infusion rate.",
  ])("treats %j as a directive", (sentence) => {
    expect(isTreatmentDirective(sentence)).toBe(true);
  });

  it.each([
    "Depth index fell from 60 to 35, indicating deepening anaesthesia.",
    "Lower readings during sedation are expected.",
    "SEF95 decreased after induction of anaesthesia.",
    "Propofol infusion was reduced at 10:05 per the drug log.",
    "Increasing suppression is consistent with deep anaesthesia.",
    "Readings should be lower during sedation.",
    "Alpha power started to rise as anaesthesia lightened.",
    "When anaesthesia deepens, lower readings during sedation are typical.",
    "If the depth index is lower during sedation, review electrode contact.",
    "Depth fell, and suppression rose during maintenance of anaesthesia.",
  ])("keeps the description %j", (sentence) => {
    expect(isTreatmentDirective(sentence)).toBe(false);
  });

  it("keeps descriptive depth, headline and alert text through the full guard", () => {
    const depth = "Depth index mean 31, indicating deepening anaesthesia.";
    const { output, report } = guardInterpretation(
      base({
        headline: "Lower readings during sedation with rising suppression.",
        depthOfAnaesthesia: depth,
        alerts: [alert({ detail: "Suppression ratio is high, consistent with deepening anaesthesia." })],
      }),
      digest,
    );
    expect(output.depthOfAnaesthesia).toBe(depth);
    expect(output.headline).toBe("Lower readings during sedation with rising suppression.");
    expect(output.alerts[0]!.detail).toBe("Suppression ratio is high, consistent with deepening anaesthesia.");
    expect(report.rules).not.toContain("treatment-directive");
  });

  it("replaces a conditional dosing instruction in an alert action with the neutral review", () => {
    const { output, report } = guardInterpretation(
      base({ alerts: [alert({ action: "If suppression persists, reduce the propofol infusion." })] }),
      digest,
    );
    expect(output.alerts[0]!.action).not.toMatch(/propofol/i);
    expect(output.alerts[0]!.action).toMatch(/clinician decision/i);
    expect(report.rules).toContain("treatment-directive");
  });

  it("still removes a directive mixed into an otherwise descriptive depth section", () => {
    const { output, report } = guardInterpretation(
      base({ depthOfAnaesthesia: "Depth index mean 31, indicating deepening anaesthesia. Consider reducing propofol." }),
      digest,
    );
    expect(output.depthOfAnaesthesia).toBe("Depth index mean 31, indicating deepening anaesthesia.");
    expect(report.rules).toContain("treatment-directive");
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
    expect(output.alerts[0]!.origin).toBe("ai_explanatory");
  });

  it("voids any model-reported feedback influence", () => {
    const { output } = guardInterpretation(
      base({ alerts: [alert({ feedbackInfluence: { adjustment: "raised_bar", note: "x" } })] }),
      digest,
    );
    expect(output.alerts[0]!.feedbackInfluence).toBeNull();
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
