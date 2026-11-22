import { describe, expect, it } from "vitest";

import {
  EVENT_DETAIL,
  EVENT_LABEL,
  derivedResponseTransitions,
  describeObservation,
  isEligibleResponseObservation,
  isPositiveResponseObservation,
  responseObservationSummary,
  trainingTargetOf,
  validateDraft,
  type CaseObservation,
  type EventType,
  type ResponseMethod,
} from "@/lib/eeg/case-observations";

function event(
  atSeconds: number,
  eventType: EventType,
  over: Partial<CaseObservation> = {},
): CaseObservation {
  return {
    id: `e${atSeconds}-${eventType}`,
    caseCode: "C1",
    sessionId: null,
    kind: "event",
    atSeconds,
    moaas: null,
    stimulus: null,
    drugName: null,
    dose: null,
    doseUnit: null,
    route: null,
    eventType,
    motorAssessable: true,
    responseMethod: "clinical_observation",
    note: null,
    ...over,
  };
}

describe("still_response is an observation, not a depth label", () => {
  it("does not claim depth adequacy", () => {
    expect(EVENT_DETAIL.still_response).not.toMatch(/depth|adequate|sedat/i);
    expect(EVENT_LABEL.still_response).toBe("No movement to stimulus");
  });

  it("keeps a negative observation out of the training targets", () => {
    const row = event(60, "still_response");
    expect(isEligibleResponseObservation(row)).toBe(true);
    expect(isPositiveResponseObservation(row)).toBe(false);
    expect(trainingTargetOf(row)).toBeNull();
  });

  it("retains a verified positive command through a usable channel", () => {
    const row = event(30, "movement_response", { responseMethod: "voluntary_command" });
    expect(isEligibleResponseObservation(row)).toBe(true);
    expect(isPositiveResponseObservation(row)).toBe(true);
    expect(trainingTargetOf(row)).toBe("responsive");
  });

  it("treats historical unspecified assessability as ineligible", () => {
    const row = event(30, "still_response", {
      motorAssessable: null,
      responseMethod: null,
    });
    expect(isEligibleResponseObservation(row)).toBe(false);
    expect(trainingTargetOf(row)).toBeNull();
    expect(derivedResponseTransitions([row])).toEqual([]);
  });

  it.each(["blocked", "unknown"] as ResponseMethod[])(
    "treats a %s negative response as ineligible",
    (method) => {
      const row = event(30, "still_response", { responseMethod: method });
      expect(isEligibleResponseObservation(row)).toBe(false);
      expect(derivedResponseTransitions([row])).toEqual([]);
    },
  );

  it("excludes a blocked motor pathway even when a method is named", () => {
    const row = event(30, "movement_response", {
      motorAssessable: false,
      responseMethod: "clinical_observation",
    });
    expect(isEligibleResponseObservation(row)).toBe(false);
    expect(trainingTargetOf(row)).toBeNull();
  });
});

describe("derived transitions and summary", () => {
  it("keeps only eligible observations, in time order", () => {
    const rows = [
      event(90, "movement_response", { responseMethod: "voluntary_command" }),
      event(30, "still_response", { motorAssessable: null, responseMethod: null }),
      event(60, "still_response"),
      event(120, "still_response", { responseMethod: "blocked" }),
    ];
    expect(derivedResponseTransitions(rows)).toEqual([
      { atSeconds: 60, direction: "negative" },
      { atSeconds: 90, direction: "positive" },
    ]);
  });

  it("counts what was stored, what was usable and what was excluded", () => {
    const summary = responseObservationSummary([
      event(10, "still_response", { motorAssessable: null, responseMethod: null }),
      event(20, "still_response", { responseMethod: "blocked" }),
      event(30, "still_response"),
      event(40, "movement_response", { responseMethod: "voluntary_command" }),
    ]);
    expect(summary).toEqual({
      observed: 4,
      eligible: 2,
      positive: 1,
      ineligibleUnspecified: 1,
      ineligibleBlocked: 1,
      negativeObserved: 3,
    });
  });
});

describe("write, read and export stay consistent", () => {
  it("requires assessability and a response method on a response event", () => {
    const missing = validateDraft({
      kind: "event",
      atSeconds: 10,
      eventType: "still_response",
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(" ")).toMatch(/assessable/i);

    const unknownMethod = validateDraft({
      kind: "event",
      atSeconds: 10,
      eventType: "movement_response",
      motorAssessable: true,
      responseMethod: "made-up" as ResponseMethod,
    });
    expect(unknownMethod.ok).toBe(false);

    const ok = validateDraft({
      kind: "event",
      atSeconds: 10,
      eventType: "still_response",
      motorAssessable: true,
      responseMethod: "clinical_observation",
    });
    expect(ok.ok).toBe(true);
  });

  it("describes the same fields that are stored", () => {
    const row = event(45, "still_response", {
      motorAssessable: false,
      responseMethod: "blocked",
    });
    const text = describeObservation(row);
    expect(text).toMatch(/No movement to stimulus/);
    expect(text).toMatch(/motor blocked/);
    expect(text).toMatch(/Motor pathway blocked/);
    expect(text).not.toMatch(/depth adequate/i);
  });
});
