import { describe, expect, it } from "vitest";

import {
  DESCRIPTOR_ONLY_TEMPLATES,
  RESEARCH_SCORE_LABEL,
  descriptorOnlyText,
  descriptorPolicy,
  impliesDepthOrSedation,
  sanitizeDescriptorOnlyExport,
} from "./descriptor-only";
import { guardInterpretation, type GuardAlert, type GuardInput } from "./interpret-guard";

const digest = {
  durationSeconds: 1800,
  suppression: { available: true, meanRatioPct: 38.2, maxRatioPct: 61.4 },
  spectral: { meanSef95Hz: 9.4 },
  quality: { usableFraction: 0.92 },
  depthIndex: { reliableFraction: 0.85, latestIsReliable: true, meanWhenReliable: 31 },
};

function alert(over: Partial<GuardAlert> = {}): GuardAlert {
  return {
    id: "depth",
    severity: "warning",
    category: "excessive_depth",
    title: "Deep pattern",
    detail: "The depth index is low.",
    action: "Review the trend.",
    confidence: "moderate",
    evidence: [{ feature: "Depth index", value: "31" }],
    ...over,
  };
}

function base(over: Partial<GuardInput> = {}): GuardInput {
  return {
    headline: "Deep pattern.",
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

describe("depth and sedation assertions", () => {
  it.each([
    "The patient is unconscious.",
    "The patient is adequately sedated.",
    "The patient is conscious and comfortable.",
    "Depth is adequate for surgery.",
    "Sedation is sufficient.",
    "There is no awareness.",
    "The patient is not aware.",
    "Current depth is stable.",
  ])("rejects %j", (sentence) => {
    expect(impliesDepthOrSedation(sentence)).toBe(true);
  });

  it.each([
    "Suppression ratio is 38.2%.",
    "SEF95 is 9.4 Hz.",
    "Awareness cannot be assessed from this recording.",
    "The depth index fell from 60 to 35, indicating deepening anaesthesia.",
    "Lower readings during sedation are expected.",
    "Review electrode contact.",
  ])("keeps the descriptor %j", (sentence) => {
    expect(impliesDepthOrSedation(sentence)).toBe(false);
  });

  it("removes patient-state claims even without a research context", () => {
    const { output, report } = guardInterpretation(
      base({
        headline: "The patient is unconscious.",
        depthOfAnaesthesia: "The patient is adequately sedated.",
        alerts: [alert({ title: "The patient is unconscious", detail: "Sedation is adequate." })],
      }),
      digest,
    );
    expect(output.headline).not.toMatch(/unconscious/i);
    expect(output.depthOfAnaesthesia).not.toMatch(/adequately sedated/i);
    expect(output.alerts[0]!.title).not.toMatch(/unconscious/i);
    expect(report.rules).toContain("descriptor-only");
  });

  it("does not restore the assertion after an unreliable-depth warning", () => {
    const unreliable = {
      ...digest,
      depthIndex: { reliableFraction: 0.2, latestIsReliable: false },
    };
    const { output } = guardInterpretation(
      base({ depthOfAnaesthesia: "The patient is unconscious." }),
      unreliable,
    );
    expect(output.depthOfAnaesthesia).toMatch(/unreliable/i);
    expect(output.depthOfAnaesthesia).not.toMatch(/unconscious/i);
  });
});

describe("withheld context", () => {
  const withheld = { ...digest, blockadeContext: null };

  it("replaces headline, depth, alerts and recommendations with fixed templates", () => {
    const { output, report } = guardInterpretation(
      base({
        headline: "The patient is unconscious.",
        depthOfAnaesthesia: "The patient is adequately sedated.",
        alerts: [alert({ category: "excessive_depth" })],
        recommendedChecks: ["Confirm the patient is unconscious.", "Check electrode contact."],
      }),
      withheld,
    );
    expect(output.descriptorOnly).toBe(true);
    expect(output.descriptorContext).toBe("missing");
    expect(output.headline).toBe(DESCRIPTOR_ONLY_TEMPLATES.headline);
    expect(output.depthOfAnaesthesia).toBe(DESCRIPTOR_ONLY_TEMPLATES.depth);
    expect(output.alerts).toHaveLength(0);
    expect(output.recommendedChecks).toEqual([DESCRIPTOR_ONLY_TEMPLATES.recommendation]);
    expect(output.limitations).toContain(DESCRIPTOR_ONLY_TEMPLATES.awareness);
    expect(output.researchScoreNote).toBe(DESCRIPTOR_ONLY_TEMPLATES.exportNote);
    expect(report.rules).toContain("descriptor-only");
  });

  it("treats documented or suspected blockade as descriptor-only", () => {
    for (const blockade of ["documented", "suspected"]) {
      const policy = descriptorPolicy({
        ...digest,
        blockadeContext: { blockade, absenceDocumented: false },
      });
      expect(policy.descriptorOnly).toBe(true);
      expect(policy.context).toBe(blockade);
    }
  });

  it("only accepts a fully evidenced reported-absent context", () => {
    const supported = descriptorPolicy({
      ...digest,
      researchContext: {
        blockade: "reported-absent",
        absenceDocumented: true,
        montageCompatible: true,
        referenceCompatible: true,
        calibrationCompatible: true,
        coverageAdequate: true,
        status: "research score",
      },
    });
    expect(supported.descriptorOnly).toBe(false);
    const bare = descriptorPolicy({ ...digest, researchContext: "reported-absent" });
    expect(bare.descriptorOnly).toBe(true);
  });

  it("leaves the legacy depth index alone when no research context is attached", () => {
    const { output } = guardInterpretation(
      base({ depthOfAnaesthesia: "Depth index mean 31, indicating deepening anaesthesia." }),
      digest,
    );
    expect(output.descriptorOnly).toBe(false);
    expect(output.depthOfAnaesthesia).toMatch(/Depth index mean 31/);
  });
});

describe("exports and clinical surfaces", () => {
  it("sanitises stale cached prose before export", () => {
    const stale = {
      headline: "The patient is unconscious.",
      depthOfAnaesthesia: "The patient is adequately sedated.",
      nested: { note: "Depth is adequate.", list: ["Sedation is sufficient."] },
    };
    const clean = sanitizeDescriptorOnlyExport(stale);
    const text = JSON.stringify(clean);
    expect(text).not.toMatch(/unconscious|adequately sedated|depth is adequate|sedation is sufficient/i);
    expect(text).toContain(DESCRIPTOR_ONLY_TEMPLATES.exportNote);
  });

  it("labels an experimental score as a research descriptor, not a depth", () => {
    expect(RESEARCH_SCORE_LABEL).toMatch(/research/i);
    expect(RESEARCH_SCORE_LABEL).not.toMatch(/depth|sedat/i);
  });

  it("drops unsupported prose from a descriptor-only string", () => {
    const text = descriptorOnlyText(
      "Suppression ratio is 38.2%. The patient is unconscious. SEF95 is 9.4 Hz.",
      "No descriptor.",
      true,
    );
    expect(text).toBe("Suppression ratio is 38.2%. SEF95 is 9.4 Hz.");
  });
});
