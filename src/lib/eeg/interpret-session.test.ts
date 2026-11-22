/**
 * Provider-boundary regressions for the session reviewer.
 *
 * The reported defect: a descriptor-only digest was serialised and sent to
 * the language model before the output guard ran. These tests mock the
 * provider and assert it is never called for such a digest — the fixed,
 * deterministic response is produced instead — while an eligible digest still
 * goes through the guard.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => builder };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { DESCRIPTOR_ONLY_TEMPLATES, descriptorPolicy } from "./descriptor-only";
import {
  AI_MODEL_VERSION,
  DESCRIPTOR_ONLY_MODEL_VERSION,
  reviewDigest,
} from "./interpret.functions";

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

const eligibleDigest = {
  durationSeconds: 1800,
  researchContext: eligibleContext,
  suppression: { available: true, meanRatioPct: 38.2 },
  quality: { usableFraction: 0.92 },
  depthIndex: { reliableFraction: 0.85, latestIsReliable: true, meanWhenReliable: 31 },
};

const noContextDigest = {
  durationSeconds: 1800,
  suppression: { available: true, meanRatioPct: 38.2 },
  quality: { usableFraction: 0.92 },
  depthIndex: { reliableFraction: 0.85, latestIsReliable: true, meanWhenReliable: 31 },
};

const modelReply = JSON.stringify({
  headline: "Suppression ratio 38.2%.",
  alerts: [],
  depthOfAnaesthesia: "SEF95 9.4 Hz.",
  burstSuppression: "Mean suppression 38.2%.",
  seizureRisk: "Low.",
  markerCorrelations: [],
  pathologyIndicators: [],
  recommendedChecks: [],
  limitations: [],
  dataQualityCaveat: "",
});

function failingProvider() {
  return vi.fn(async () => {
    throw new Error("provider must not be called for a descriptor-only digest");
  });
}

describe("descriptor-only digests", () => {
  it("short-circuits before the provider, without an API key", async () => {
    const provider = failingProvider();

    const output = await reviewDigest(noContextDigest, { provider });

    expect(provider).not.toHaveBeenCalled();
    expect(output.descriptorOnly).toBe(true);
    expect(output.headline).toBe(DESCRIPTOR_ONLY_TEMPLATES.headline);
    expect(output.depthOfAnaesthesia).toBe(DESCRIPTOR_ONLY_TEMPLATES.depth);
    expect(output.alerts).toEqual([]);
    expect(output.descriptorEvidenceKey).toBeNull();
    expect(output.modelVersion).toBe(DESCRIPTOR_ONLY_MODEL_VERSION);
  });

  it.each([
    ["documented blockade", { ...noContextDigest, blockade_context: "documented" }],
    ["suspected blockade", { ...noContextDigest, blockade_context: "suspected" }],
    ["bare string context", { ...noContextDigest, researchContext: "reported-absent" }],
    [
      "conflicting aliases",
      { ...noContextDigest, researchContext: eligibleContext, blockade_context: "documented" },
    ],
  ])("short-circuits for %s", async (_label, digest) => {
    const provider = failingProvider();
    const output = await reviewDigest(digest, { provider, apiKey: "test-key" });
    expect(provider).not.toHaveBeenCalled();
    expect(output.descriptorOnly).toBe(true);
  });
});

describe("eligible digests", () => {
  it("calls the provider once and still applies the output guard", async () => {
    const provider = vi.fn(async (_body: unknown, _key: string) => modelReply);

    const output = await reviewDigest(eligibleDigest, { provider, apiKey: "test-key" });

    expect(provider).toHaveBeenCalledTimes(1);
    const [body, key] = provider.mock.calls[0]!;
    expect(key).toBe("test-key");
    // Only the numeric digest is sent — no separate free-text channel.
    const sent = body as { input: { content: string }[] };
    expect(sent.input[1]!.content.endsWith(JSON.stringify(eligibleDigest))).toBe(true);
    expect(output.descriptorOnly).toBe(false);
    expect(output.modelVersion).toBe(AI_MODEL_VERSION);
    expect(output.descriptorEvidenceKey).toBe(descriptorPolicy(eligibleDigest).evidenceKey);
  });

  it("removes a patient-state assertion from a provider reply", async () => {
    const provider = vi.fn(async () =>
      JSON.stringify({
        ...JSON.parse(modelReply),
        headline: "The patient is unconscious.",
      }),
    );

    const output = await reviewDigest(eligibleDigest, { provider, apiKey: "test-key" });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(output.headline).not.toMatch(/unconscious/i);
  });

  it("requires an API key only when the provider would be consulted", async () => {
    await expect(reviewDigest(eligibleDigest, { apiKey: undefined })).rejects.toThrow(
      /not configured/i,
    );
  });
});
