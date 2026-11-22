import { describe, expect, it } from "vitest";

import {
  DESCRIPTOR_ONLY_TEMPLATES,
  RESEARCH_SCORE_LABEL,
  descriptorOnlyText,
  descriptorPolicy,
  impliesDepthOrSedation,
  sanitizeDescriptorOnlyExport,
} from "./descriptor-only";
import {
  guardInterpretation,
  sanitizeCachedInterpretation,
  type GuardAlert,
  type GuardInput,
} from "./interpret-guard";

const eligibleContext = {
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
  researchContext: eligibleContext,
  suppression: { available: true, meanRatioPct: 38.2, maxRatioPct: 61.4 },
  spectral: { meanSef95Hz: 9.4 },
  quality: { usableFraction: 0.92 },
  depthIndex: { reliableFraction: 0.85, latestIsReliable: true, meanWhenReliable: 31 },
};

const noContextDigest = {
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

describe("fail-closed context resolution", () => {
  it("withholds every absent or unknown context", () => {
    for (const digest of [
      {},
      { durationSeconds: 1800 },
      { researchContext: null },
      { blockade_context: "documented" },
      { blockade_context: "suspected" },
      { blockade_context: "unknown" },
      { researchContext: "reported-absent" },
      { researchContext: { blockade: "reported-absent" } },
    ]) {
      const policy = descriptorPolicy(digest);
      expect(policy.descriptorOnly, JSON.stringify(digest)).toBe(true);
      expect(policy.scoreEligible).toBe(false);
    }
  });

  it("treats disagreeing camelCase and snake_case aliases as a conflict", () => {
    const policy = descriptorPolicy({
      ...digest,
      researchContext: { ...eligibleContext, blockade: "reported-absent" },
      blockade_context: "documented",
    });
    expect(policy.descriptorOnly).toBe(true);
    expect(policy.context).toBe("conflicting");
  });

  it("rejects non-boolean safety flags and unqualified references", () => {
    expect(
      descriptorPolicy({
        ...digest,
        researchContext: { ...eligibleContext, absenceDocumented: "yes" },
      }).descriptorOnly,
    ).toBe(true);
    expect(
      descriptorPolicy({
        ...digest,
        researchContext: { ...eligibleContext, reference: "arbitrary" },
      }).descriptorOnly,
    ).toBe(true);
  });

  it("requires acquisition identity, time and full coverage", () => {
    expect(
      descriptorPolicy({ ...digest, researchContext: { ...eligibleContext, caseId: "" } })
        .descriptorOnly,
    ).toBe(true);
    expect(
      descriptorPolicy({ ...digest, researchContext: { ...eligibleContext, acquiredAt: "" } })
        .descriptorOnly,
    ).toBe(true);
    expect(
      descriptorPolicy({
        ...digest,
        researchContext: {
          ...eligibleContext,
          intervals: [
            {
              start: 0,
              end: 1,
              absenceDocumented: true,
              reference: "mastoid",
              calibration: "uV",
              recordedAt: "2026-11-21T10:00:00Z",
            },
          ],
        },
      }).descriptorOnly,
    ).toBe(true);
  });

  it("rejects a caller-increased evidence lifetime", () => {
    expect(
      descriptorPolicy({
        ...digest,
        researchContext: { ...eligibleContext, maxContextAgeHours: 240 },
      }).descriptorOnly,
    ).toBe(true);
  });

  it("accepts a fully evidenced reported-absent context as the positive control", () => {
    const policy = descriptorPolicy(digest);
    expect(policy.descriptorOnly).toBe(false);
    expect(policy.scoreEligible).toBe(true);
    expect(policy.context).toBe("reported-absent");
    expect(policy.researchOnly).toBe(true);
  });

  it("accepts a fully evidenced interval context", () => {
    const policy = descriptorPolicy({
      ...digest,
      researchContext: {
        blockade: "reported-absent",
        caseId: "case-1",
        acquiredAt: "2026-11-21T12:00:00Z",
        reference: "mastoid",
        intervals: [
          {
            start: 0,
            end: 1800,
            absenceDocumented: true,
            reference: "mastoid",
            calibration: "uV",
            recordedAt: "2026-11-21T10:00:00Z",
          },
        ],
      },
    });
    expect(policy.descriptorOnly).toBe(false);
  });
});

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

  it("uses deterministic templates for every free-text field without a context", () => {
    const { output, report } = guardInterpretation(
      base({
        headline: "They appear to be sleeping peacefully.",
        depthOfAnaesthesia: "Consistent with deepening anaesthesia.",
        burstSuppression: "The patient is adequately sedated.",
        seizureRisk: "Consistent with deepening anaesthesia.",
        alerts: [alert({ title: "They appear to be sleeping peacefully" })],
      }),
      noContextDigest,
    );
    expect(output.descriptorOnly).toBe(true);
    expect(output.descriptorContext).toBe("missing");
    expect(output.headline).toBe(DESCRIPTOR_ONLY_TEMPLATES.headline);
    expect(output.depthOfAnaesthesia).toBe(DESCRIPTOR_ONLY_TEMPLATES.depth);
    expect(output.burstSuppression).toBe(DESCRIPTOR_ONLY_TEMPLATES.measured);
    expect(output.seizureRisk).toBe(DESCRIPTOR_ONLY_TEMPLATES.measured);
    expect(output.alerts).toHaveLength(0);
    expect(output.recommendedChecks).toEqual([DESCRIPTOR_ONLY_TEMPLATES.recommendation]);
    expect(output.limitations).toContain(DESCRIPTOR_ONLY_TEMPLATES.awareness);
    expect(output.researchScoreNote).toBe(DESCRIPTOR_ONLY_TEMPLATES.exportNote);
    const text = JSON.stringify(output);
    expect(text).not.toMatch(/sleeping peacefully|deepening anaesthesia|adequately sedated/i);
    expect(report.rules).toContain("descriptor-only");
  });

  it("still strips patient-state claims under an eligible context", () => {
    const { output } = guardInterpretation(
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
  });

  it("labels every experimental score as a research descriptor", () => {
    expect(RESEARCH_SCORE_LABEL).toMatch(/research/i);
    expect(RESEARCH_SCORE_LABEL).not.toMatch(/depth|sedat/i);
    const { output } = guardInterpretation(base(), digest);
    expect(output.researchScoreLabel).toBe(RESEARCH_SCORE_LABEL);
    expect(output.researchScoreNote).toBe(DESCRIPTOR_ONLY_TEMPLATES.exportNote);
  });
});

describe("cached and exported text", () => {
  it("sanitises a cached result that does not explicitly say descriptorOnly:false", () => {
    const cached = {
      headline: "They appear to be sleeping peacefully.",
      depthOfAnaesthesia: "Consistent with deepening anaesthesia.",
      alerts: [alert()],
    } as unknown as GuardInput;
    const clean = sanitizeCachedInterpretation(cached);
    expect(clean.descriptorOnly).toBe(true);
    expect(clean.headline).toBe(DESCRIPTOR_ONLY_TEMPLATES.headline);
    expect(clean.depthOfAnaesthesia).toBe(DESCRIPTOR_ONLY_TEMPLATES.depth);
    expect(clean.alerts).toHaveLength(0);
    expect(JSON.stringify(clean)).not.toMatch(/sleeping peacefully|deepening anaesthesia/i);
  });

  it("reuses an eligible cached result only while the current evidence matches", () => {
    const key = descriptorPolicy(digest).evidenceKey!;
    const eligible = base({ descriptorOnly: false, descriptorEvidenceKey: key });
    expect(sanitizeCachedInterpretation(eligible, digest)).toBe(eligible);
  });

  it("withholds an explicitly eligible old result when no current evidence is supplied", () => {
    const key = descriptorPolicy(digest).evidenceKey!;
    const eligible = base({
      descriptorOnly: false,
      descriptorEvidenceKey: key,
      headline: "The patient is unconscious.",
    });
    const clean = sanitizeCachedInterpretation(eligible);
    expect(clean.descriptorOnly).toBe(true);
    expect(clean.headline).toBe(DESCRIPTOR_ONLY_TEMPLATES.headline);
    expect(JSON.stringify(clean)).not.toMatch(/unconscious/i);
  });

  it("withholds an eligible old result when the case or interval evidence changed", () => {
    const key = descriptorPolicy(digest).evidenceKey!;
    const eligible = base({
      descriptorOnly: false,
      descriptorEvidenceKey: key,
      headline: "The patient is unconscious.",
    });
    const changed = {
      ...digest,
      researchContext: { ...eligibleContext, caseId: "case-2" },
    };
    const clean = sanitizeCachedInterpretation(eligible, changed);
    expect(clean.descriptorOnly).toBe(true);
    expect(clean.descriptorReason).toMatch(/changed/i);
    expect(JSON.stringify(clean)).not.toMatch(/unconscious/i);
  });

  it("withholds an eligible old result that carries no evidence fingerprint", () => {
    const eligible = base({
      descriptorOnly: false,
      headline: "The patient is unconscious.",
    });
    const clean = sanitizeCachedInterpretation(eligible, digest);
    expect(clean.descriptorOnly).toBe(true);
    expect(JSON.stringify(clean)).not.toMatch(/unconscious/i);
  });

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

  it("drops unsupported prose from a descriptor-only string", () => {
    const text = descriptorOnlyText(
      "Suppression ratio is 38.2%. The patient is unconscious. SEF95 is 9.4 Hz.",
      "No descriptor.",
      true,
    );
    expect(text).toBe("Suppression ratio is 38.2%. SEF95 is 9.4 Hz.");
  });
});
