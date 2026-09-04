import { describe, expect, it } from "vitest";

import { fitCoebisModel } from "@/lib/eeg/coebis-covariates";
import {
  MIN_CASE_READINGS,
  SUPPRESSION_PCT_THRESHOLD,
  buildPatientRows,
  spreadOf,
  summarisePatientCohort,
  thinCaseSeries,
  type PatientLineageModel,
  type PatientReadingInput,
  type ReferenceKind,
  divergenceOf,
} from "@/lib/eeg/patient-scores";

function reading(over: Partial<PatientReadingInput> & { at: number }): PatientReadingInput {
  return {
    caseKey: "case-a",
    caseLabel: "Case A",
    lineageKey: "muse-2|AF7|256",
    recordedAt: new Date(1_700_000_000_000 + over.at * 1000).toISOString(),
    reference: 50,
    appIndex: 60,
    appSr: 0,
    appSef: 12,
    refSr: null,
    refSef: null,
    reliable: true,
    referenceKind: "monitor" as ReferenceKind,
    monitor: "BIS VISTA",
    cov: null,
    ageYears: null,
    ce: null,
    ...over,
  };
}

/** A case's worth of readings where the app reads a fixed offset above the reference. */
function caseReadings(
  caseKey: string,
  n: number,
  over: Partial<PatientReadingInput> = {},
): PatientReadingInput[] {
  return Array.from({ length: n }, (_, i) =>
    reading({
      at: i * 10,
      caseKey,
      caseLabel: caseKey,
      reference: 40 + (i % 20),
      appIndex: 50 + (i % 20),
      ...over,
    }),
  );
}

describe("per-patient COEBIS scoreboard", () => {
  it("groups readings per case and keeps each case's own reference", () => {
    const rows = buildPatientRows(
      [...caseReadings("case-a", 20), ...caseReadings("case-b", 20, { referenceKind: "moaas-score", monitor: null })],
      new Map(),
    );
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.caseKey === "case-a")!;
    const b = rows.find((r) => r.caseKey === "case-b")!;
    expect(a.reference.isMonitor).toBe(true);
    expect(a.reference.label).toBe("BIS VISTA");
    expect(b.reference.isMonitor).toBe(false);
    expect(b.reference.label).toBe("MOAA/S score");
    expect(b.verdict).toContain("not a BIS monitor");
  });

  it("reports the open index when the lineage has no promoted model", () => {
    const rows = buildPatientRows(caseReadings("case-a", 20), new Map());
    const row = rows[0]!;
    expect(row.hasModel).toBe(false);
    expect(row.agreement).toBeNull();
    expect(row.raw.bias).toBeCloseTo(10, 5);
    expect(row.maeGain).toBeNull();
    expect(row.verdict).toContain("No promoted COEBIS model");
  });

  it("scores readings under the lineage's live model without borrowing the case's own intercept", () => {
    const training = caseReadings("case-a", 40).map((r) => ({
      at: r.at,
      bis: r.reference,
      appIndex: r.appIndex,
      appSr: r.appSr,
      sessionId: r.caseKey,
      reliable: true,
      sqi: null,
      depthConfidence: null,
      recordedAt: r.recordedAt,
      context: null,
      ce: null,
      lineageKey: r.lineageKey,
      cov: {},
    }));
    const model = fitCoebisModel(training, "affine");
    expect(model).not.toBeNull();
    const models = new Map<string, PatientLineageModel>([
      ["muse-2|AF7|256", { model: model!, version: 2 }],
    ]);

    const row = buildPatientRows(caseReadings("case-a", 40), models)[0]!;
    expect(row.hasModel).toBe(true);
    expect(row.modelVersion).toBe(2);
    // The fitted model removes the +10 offset, so it must beat the open index.
    expect(row.agreement!.mae!).toBeLessThan(row.raw.mae!);
    expect(row.maeGain!).toBeGreaterThan(0);
  });

  it("summarises suppression burden and spectral edge from the app's own readings", () => {
    const readings = caseReadings("case-a", 20).map((r, i) =>
      i < 5 ? { ...r, appSr: 40, appSef: 4 } : { ...r, appSr: 0, appSef: 14 },
    );
    const row = buildPatientRows(readings, new Map())[0]!;
    expect(row.suppression.maxPct).toBe(40);
    expect(row.suppression.burdenPct).toBe(25);
    expect(row.suppression.meanPct).toBe(10);
    expect(row.sef95.app.median).toBe(14);
    expect(row.sef95.app.min).toBe(4);
    expect(row.verdict).toContain("suppressed");
  });

  it("only claims an age when the case record carries one", () => {
    const withAge = buildPatientRows(
      caseReadings("case-a", 20, { ageYears: 71, cov: { ageBand: "65-79" } }),
      new Map(),
    )[0]!;
    expect(withAge.age).toEqual({ years: 71, band: "65-79", source: "case-record" });

    const imported = buildPatientRows(caseReadings("case-b", 20), new Map())[0]!;
    expect(imported.age).toEqual({ years: null, band: null, source: "not-published" });
  });

  it("marks a thin case as insufficient rather than quoting its agreement as fact", () => {
    const row = buildPatientRows(caseReadings("case-a", MIN_CASE_READINGS - 1), new Map())[0]!;
    expect(row.sufficient).toBe(false);
    expect(row.verdict).toContain(`below the ${MIN_CASE_READINGS}`);
  });

  it("counts reference kinds separately and never pools agreement across them", () => {
    const cohort = summarisePatientCohort(
      buildPatientRows(
        [
          ...caseReadings("case-a", 20),
          ...caseReadings("case-b", 20, { referenceKind: "event-state", monitor: null }),
          ...caseReadings("case-c", 20, { appSr: SUPPRESSION_PCT_THRESHOLD + 1 }),
        ],
        new Map(),
      ),
    );
    expect(cohort.monitorCases).toBe(2);
    expect(cohort.annotationCases).toBe(1);
    expect(cohort.casesWithSuppression).toBe(1);
    expect(cohort.casesWithAge).toBe(0);
    expect(cohort.totalReadings).toBe(60);
    // No model anywhere, so there is no per-case MAE to take a median of.
    expect(cohort.medianMae).toBeNull();
  });

  it("thins long cases for display while keeping the ends", () => {
    const row = buildPatientRows(caseReadings("case-a", 900), new Map())[0]!;
    expect(row.series.length).toBeLessThanOrEqual(200);
    expect(row.series[0]!.at).toBe(0);
    expect(row.series[row.series.length - 1]!.at).toBe(8990);
    expect(thinCaseSeries([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it("reports spreads without inventing values for missing measurements", () => {
    expect(spreadOf([])).toEqual({ median: null, p10: null, p90: null, min: null, max: null });
    expect(spreadOf([null, 10, 20, null]).median).toBe(15);
  });
});

describe("divergenceOf", () => {
  it("reports the widest gap with its second and both values", () => {
    const d = divergenceOf(
      [
        { at: 0, reference: 50, displayed: 52, sr: 0 },
        { at: 60, reference: 40, displayed: 65, sr: 0 },
        { at: 120, reference: 45, displayed: 46, sr: 0 },
      ],
      "coebis",
    );
    expect(d.maxAbs).toBe(25);
    expect(d.worstAt).toBe(60);
    expect(d.worstReference).toBe(40);
    expect(d.worstDisplayed).toBe(65);
    expect(d.beyond10Pct).toBeCloseTo(33.3, 0);
    expect(d.beyond10SuppressedPct).toBeNull();
  });

  it("separates divergence inside suppression from the rest", () => {
    const d = divergenceOf(
      [
        { at: 0, reference: 30, displayed: 31, sr: 0 },
        { at: 10, reference: 20, displayed: 40, sr: 40 },
        { at: 20, reference: 18, displayed: 44, sr: 60 },
      ],
      "open-index",
    );
    expect(d.source).toBe("open-index");
    expect(d.beyond10SuppressedPct).toBe(100);
  });

  it("returns nulls when there is nothing comparable", () => {
    expect(divergenceOf([], "coebis").maxAbs).toBeNull();
  });
});
