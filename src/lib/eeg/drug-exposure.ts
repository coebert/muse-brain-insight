/**
 * Drug exposure per case, with the grades that say whether the index can be
 * trusted on that case.
 *
 * The drug library answers "what does each agent do and how many cases have we
 * seen?". This module answers the bedside question underneath it: for every
 * case held here, which agents were recorded, how does COEBIS read under them,
 * how much of the recording was suppressed, and — where independent labels
 * exist — does the index actually separate anaesthetised from awake and agree
 * with the recorded suppression?
 *
 * Exposure is always taken from the record (regimen, effect-site entry,
 * clinician marker), never inferred from the EEG. A case with no recorded agent
 * is reported as unexposed rather than guessed at, and cohorts are compared
 * only on cases that clear the labelling bar.
 */

import { DRUG_BY_KEY, drugStage, type DrugKey, type DrugRole } from "./drug-signatures";
import type { KetamineFeatures } from "./ketamine";
import {
  APP_SUPPRESSED_PCT,
  MIN_GRADED_EPOCHS,
  MIN_STATE_ARM,
  stateGrade,
  suppressionGrade,
  type KetamineCaseEpoch,
  type StateGrade,
  type SuppressionGrade,
} from "./ketamine-cases";
import { MIN_AXIS_CASES } from "./pathology-labels";
import type { DepthStateLabel, SuppressionLabel } from "./pathology-labels";

/** One analysed epoch of a case, with every agent the record names. */
export interface DrugExposureEpoch {
  lineage: string;
  caseRef: string;
  atSeconds: number;
  features: KetamineFeatures;
  /** COEBIS (or the app depth index) for this epoch. */
  coebis: number | null;
  /** App-measured suppression ratio, percent. */
  suppressionPct: number | null;
  suppressionLabel: SuppressionLabel | null;
  stateLabel: DepthStateLabel | null;
  /** Agents recorded for this case. */
  declared: DrugKey[];
  /**
   * True when the epoch was pulled *because* it carries an independent label.
   * Those rows feed the grades but are left out of the descriptive means, which
   * would otherwise be skewed towards the labelled parts of the recording.
   */
  labelSlice?: boolean;
}

export interface ExposureCase {
  lineage: string;
  caseRef: string;
  epochs: number;
  /** Agents recorded for this case, in registry order. */
  drugs: DrugKey[];
  drugLabels: string[];
  /** Mean index across the case, and the lowest epoch mean-of-record. */
  meanIndex: number | null;
  minIndex: number | null;
  /** Fraction of epochs whose index sits in the anaesthetic range. */
  anaestheticFraction: number | null;
  meanSuppressionPct: number | null;
  /** Fraction of epochs the app calls suppressed. */
  suppressedFraction: number | null;
  /** Mean movement the drug corrections apply, in index points. */
  meanCorrection: number | null;
  correctedEpochs: number;
  suppression: SuppressionGrade;
  state: StateGrade;
}

/** How one agent's cases read, pooled. */
export interface DrugCohort {
  key: DrugKey | "none";
  label: string;
  role: DrugRole | "none";
  cases: number;
  epochs: number;
  meanIndex: number | null;
  meanSuppressionPct: number | null;
  suppressedFraction: number | null;
  meanCorrection: number | null;
  /** Labelled epochs on each arm, pooled across the cohort's cases. */
  anaesthetisedEpochs: number;
  awakeEpochs: number;
  /** Mean awake index minus mean anaesthetised index, in points. */
  separation: number | null;
  /** Cases whose depth-state grade could be computed at all. */
  gradedCases: number;
  /** Cases where the index separated the two states. */
  separatingCases: number;
  /** Cases where the app's suppression ratio agreed with the recorded label. */
  agreeingCases: number;
  /** Whether the cohort has enough independent cases to be compared. */
  comparable: boolean;
}

export interface DrugExposureReport {
  cases: ExposureCase[];
  cohorts: DrugCohort[];
  scanned: number;
  totals: {
    cases: number;
    exposedCases: number;
    unexposedCases: number;
    gradedCases: number;
    comparableCohorts: number;
  };
  notes: string[];
}

/** Index at or below which an epoch reads as anaesthetised. */
export const ANAESTHETIC_INDEX = 83;

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
}

function fraction(hits: number, total: number): number | null {
  if (!total) return null;
  return Number((hits / total).toFixed(3));
}

/** Grades reuse the ketamine per-case shape, which takes a single declaration. */
function asGradedEpochs(epochs: DrugExposureEpoch[]): KetamineCaseEpoch[] {
  return epochs.map((e) => ({
    lineage: e.lineage,
    caseRef: e.caseRef,
    atSeconds: e.atSeconds,
    features: e.features,
    coebis: e.coebis,
    suppressionPct: e.suppressionPct,
    suppressionLabel: e.suppressionLabel,
    stateLabel: e.stateLabel,
    declared: e.declared.includes("ketamine"),
  }));
}

function profileRows(epochs: DrugExposureEpoch[]): DrugExposureEpoch[] {
  const profile = epochs.filter((e) => !e.labelSlice);
  return profile.length ? profile : epochs;
}

export function summariseExposureCase(caseEpochs: DrugExposureEpoch[]): ExposureCase {
  const first = caseEpochs[0]!;
  const profile = profileRows(caseEpochs);
  const drugSet = new Set<DrugKey>();
  for (const e of caseEpochs) for (const d of e.declared) drugSet.add(d);
  const drugs = [...DRUG_BY_KEY.keys()].filter((k) => drugSet.has(k));

  const indices = profile.map((e) => e.coebis).filter((v): v is number => v != null);
  const suppression = profile.map((e) => e.suppressionPct).filter((v): v is number => v != null);

  const deltas: number[] = [];
  for (const e of profile) {
    if (!drugs.length || e.coebis == null) continue;
    const stage = drugStage({
      aligned: e.coebis,
      features: e.features,
      declared: drugs,
      bsr: e.suppressionPct ?? 0,
    });
    if (stage.delta !== 0) deltas.push(stage.delta);
  }

  return {
    lineage: first.lineage,
    caseRef: first.caseRef,
    epochs: caseEpochs.length,
    drugs,
    drugLabels: drugs.map((k) => DRUG_BY_KEY.get(k)?.label ?? k),
    meanIndex: mean(indices),
    minIndex: indices.length ? Number(Math.min(...indices).toFixed(2)) : null,
    anaestheticFraction: fraction(
      indices.filter((v) => v <= ANAESTHETIC_INDEX).length,
      indices.length,
    ),
    meanSuppressionPct: mean(suppression),
    suppressedFraction: fraction(
      suppression.filter((v) => v >= APP_SUPPRESSED_PCT).length,
      suppression.length,
    ),
    meanCorrection: mean(deltas),
    correctedEpochs: deltas.length,
    suppression: suppressionGrade(asGradedEpochs(caseEpochs)),
    state: stateGrade(asGradedEpochs(caseEpochs)),
  };
}

function cohortOf(
  key: DrugKey | "none",
  label: string,
  role: DrugRole | "none",
  cases: ExposureCase[],
  epochs: DrugExposureEpoch[],
): DrugCohort {
  const profile = profileRows(epochs);
  const indices = profile.map((e) => e.coebis).filter((v): v is number => v != null);
  const suppression = profile.map((e) => e.suppressionPct).filter((v): v is number => v != null);
  const arm = (state: DepthStateLabel) =>
    epochs.filter((e) => e.stateLabel === state && e.coebis != null).map((e) => e.coebis as number);
  const anaes = arm("anaesthetised");
  const awake = arm("awake");
  const meanAnaes = mean(anaes);
  const meanAwake = mean(awake);
  const corrections = cases
    .map((c) => c.meanCorrection)
    .filter((v): v is number => v != null);

  return {
    key,
    label,
    role,
    cases: cases.length,
    epochs: epochs.length,
    meanIndex: mean(indices),
    meanSuppressionPct: mean(suppression),
    suppressedFraction: fraction(
      suppression.filter((v) => v >= APP_SUPPRESSED_PCT).length,
      suppression.length,
    ),
    meanCorrection: mean(corrections),
    anaesthetisedEpochs: anaes.length,
    awakeEpochs: awake.length,
    separation:
      meanAnaes != null && meanAwake != null && anaes.length >= MIN_STATE_ARM && awake.length >= MIN_STATE_ARM
        ? Number((meanAwake - meanAnaes).toFixed(2))
        : null,
    gradedCases: cases.filter((c) => c.state.grade !== "insufficient").length,
    separatingCases: cases.filter((c) => c.state.grade === "separates").length,
    agreeingCases: cases.filter((c) => c.suppression.grade === "agrees").length,
    comparable: cases.length >= MIN_AXIS_CASES && epochs.length >= MIN_GRADED_EPOCHS,
  };
}

/** Per-case exposure plus the per-agent cohorts, most exposed agents first. */
export function summariseDrugExposure(
  epochs: DrugExposureEpoch[],
  scanned = epochs.length,
): DrugExposureReport {
  const byCase = new Map<string, DrugExposureEpoch[]>();
  for (const epoch of epochs) {
    const key = `${epoch.lineage}/${epoch.caseRef}`;
    byCase.set(key, [...(byCase.get(key) ?? []), epoch]);
  }
  const cases = [...byCase.values()].map(summariseExposureCase);
  const caseKey = (c: ExposureCase) => `${c.lineage}/${c.caseRef}`;
  const epochsOf = (list: ExposureCase[]) => list.flatMap((c) => byCase.get(caseKey(c)) ?? []);

  const cohorts: DrugCohort[] = [];
  for (const [key, spec] of DRUG_BY_KEY) {
    const members = cases.filter((c) => c.drugs.includes(key));
    if (!members.length) continue;
    cohorts.push(cohortOf(key, spec.label, spec.role, members, epochsOf(members)));
  }
  const unexposed = cases.filter((c) => !c.drugs.length);
  if (unexposed.length) {
    cohorts.push(cohortOf("none", "No agent recorded", "none", unexposed, epochsOf(unexposed)));
  }
  cohorts.sort(
    (a, b) =>
      Number(b.comparable) - Number(a.comparable) ||
      b.cases - a.cases ||
      a.label.localeCompare(b.label),
  );

  cases.sort(
    (a, b) =>
      b.drugs.length - a.drugs.length ||
      b.epochs - a.epochs ||
      a.caseRef.localeCompare(b.caseRef),
  );

  const gradedCases = cases.filter(
    (c) => c.state.grade !== "insufficient" || c.suppression.grade !== "insufficient",
  ).length;
  const comparableCohorts = cohorts.filter((c) => c.comparable && c.key !== "none").length;

  const notes: string[] = [];
  if (unexposed.length) {
    notes.push(
      `${unexposed.length} of ${cases.length} cases record no agent. They are shown for reference and carry no drug correction — an unrecorded agent is an uncorrected one.`,
    );
  }
  notes.push(
    `A cohort is only marked comparable with at least ${MIN_AXIS_CASES} cases and ${MIN_GRADED_EPOCHS} epochs behind it. Cohorts share cases: a case on propofol and remifentanil counts in both.`,
  );
  notes.push(
    "Depth-state separation and suppression agreement are graded against independently recorded labels only. Where a case carries none, the grade is withheld rather than assumed.",
  );

  return {
    cases,
    cohorts,
    scanned,
    totals: {
      cases: cases.length,
      exposedCases: cases.filter((c) => c.drugs.length > 0).length,
      unexposedCases: unexposed.length,
      gradedCases,
      comparableCohorts,
    },
    notes,
  };
}

export function emptyDrugExposure(): DrugExposureReport {
  return summariseDrugExposure([], 0);
}
