/**
 * Per-patient COEBIS scoreboard (pure core).
 *
 * One row per case: what COEBIS said, what the reference said, and the two
 * things that decide whether the comparison means anything — how much of the
 * record was suppressed, and where the spectral edge sat. Age is shown only
 * when the case record carries it; the open datasets publish no ages and this
 * must never be implied otherwise.
 *
 * Agreement is only ever computed inside one case against one reference, and
 * the reference kind travels with every number: a bedside BIS monitor is a
 * real device output, while a MOAA/S score or an event-file state is a
 * clinical annotation mapped onto the 0-100 scale and cannot be read as BIS.
 */

import {
  agreementSummary,
  predictCoebis,
  type AgreementSummary,
  type CoebisModel,
} from "./coebis-covariates";
import type { CaseCovariates } from "./covariates";

/** app_sr / bis_sr are stored as percentages; at or above this counts as suppressed. */
export const SUPPRESSION_PCT_THRESHOLD = 5;
/** Below this a case's agreement numbers describe a handful of seconds, not a case. */
export const MIN_CASE_READINGS = 12;
/** Samples kept per case for the detail chart. */
export const MAX_CASE_SERIES = 200;

export type ReferenceKind = "monitor" | "moaas-score" | "event-state" | "unknown";

export interface ReferenceMeta {
  kind: ReferenceKind;
  /** Short label for the column header, e.g. "BIS VISTA" or "MOAA/S score". */
  label: string;
  /** True only for a real bedside depth monitor output. */
  isMonitor: boolean;
  /** Sentence stating what the reference actually is. */
  note: string;
}

export const REFERENCE_META: Record<ReferenceKind, Omit<ReferenceMeta, "label">> = {
  monitor: {
    kind: "monitor",
    isMonitor: true,
    note: "Recorded bedside monitor index, sampled alongside the app's own reading.",
  },
  "moaas-score": {
    kind: "moaas-score",
    isMonitor: false,
    note: "Observer sedation score (MOAA/S) mapped onto the 0-100 scale — a six-level clinical grade, not a monitor output.",
  },
  "event-state": {
    kind: "event-state",
    isMonitor: false,
    note: "Anaesthetic state read from the dataset's event file and mapped onto the 0-100 scale — a state annotation, not a monitor output.",
  },
  unknown: {
    kind: "unknown",
    isMonitor: false,
    note: "Reference of unrecorded provenance; treat the agreement figures as indicative only.",
  },
};

export interface PatientReadingInput {
  caseKey: string;
  caseLabel: string;
  lineageKey: string | null;
  recordedAt: string;
  /** Case-clock seconds. */
  at: number;
  /** Reference value on the 0-100 scale. */
  reference: number;
  /** Open index before any COEBIS correction. */
  appIndex: number;
  /** App suppression ratio, percent. */
  appSr: number | null;
  /** App spectral edge frequency, Hz. */
  appSef: number | null;
  /** Reference suppression ratio, percent, when the reference reports one. */
  refSr: number | null;
  /** Reference spectral edge frequency, Hz, when the reference reports one. */
  refSef: number | null;
  reliable: boolean;
  referenceKind: ReferenceKind;
  /** Device the reference came from, as filed. */
  monitor: string | null;
  cov: CaseCovariates | null;
  ageYears: number | null;
  ce: Record<string, number> | null;
}

export interface PatientSeriesSample {
  at: number;
  reference: number;
  raw: number;
  coebis: number | null;
  sr: number | null;
  sef: number | null;
  /** Reference monitor's own suppression ratio, percent, when it reports one. */
  refSr: number | null;
  /** Reference monitor's own spectral edge, Hz, when it reports one. */
  refSef: number | null;
  /**
   * Displayed index minus the reference at this instant: COEBIS where a model
   * is in force, the open index otherwise. Positive = the app reads lighter.
   */
  gap: number | null;
}

/** Where the displayed index sits against the reference across the case. */
export interface DivergenceSummary {
  /** Which trace the gap describes. */
  source: "coebis" | "open-index";
  meanAbs: number | null;
  maxAbs: number | null;
  /** Case-clock second of the widest gap. */
  worstAt: number | null;
  /** Reference value at the widest gap. */
  worstReference: number | null;
  /** Displayed index at the widest gap. */
  worstDisplayed: number | null;
  /** Share of readings more than 10 points from the reference, percent. */
  beyond10Pct: number | null;
  /** Same, restricted to readings at or above the suppression threshold. */
  beyond10SuppressedPct: number | null;
}


export interface Spread {
  median: number | null;
  p10: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
}

export interface PatientScoreRow {
  caseKey: string;
  caseLabel: string;
  lineageKey: string;
  /** Live COEBIS version scoring this case, null when the lineage has no model. */
  modelVersion: number | null;
  hasModel: boolean;
  reference: ReferenceMeta;
  readings: number;
  reliableReadings: number;
  firstAt: string;
  lastAt: string;
  /** Case-clock span the readings cover, seconds. */
  spanSeconds: number;
  age: {
    years: number | null;
    band: string | null;
    /** Where the age came from, or why it is absent. */
    source: "case-record" | "not-published";
  };
  sex: string | null;
  regimen: string | null;
  coebis: Spread;
  referenceSpread: Spread;
  suppression: {
    /** Mean app suppression ratio across the case, percent. */
    meanPct: number | null;
    maxPct: number | null;
    /** Share of readings at or above the suppression threshold, percent. */
    burdenPct: number | null;
    /** Same, from the reference monitor, when it reports a suppression ratio. */
    referenceMeanPct: number | null;
    referenceBurdenPct: number | null;
  };
  sef95: {
    app: Spread;
    referenceMedian: number | null;
  };
  /** COEBIS vs this case's reference. Null when the lineage has no model. */
  agreement: AgreementSummary | null;
  /** Open index vs the same reference, on the same readings. */
  raw: AgreementSummary;
  /** raw MAE − COEBIS MAE; positive = the model helps in this case. */
  maeGain: number | null;
  /** Enough readings to read the agreement figures as describing the case. */
  sufficient: boolean;
  /** Plain reading of this case. */
  verdict: string;
  /** Where the displayed index parts company with the reference. */
  divergence: DivergenceSummary;
  series: PatientSeriesSample[];

}

export interface PatientCohort {
  rows: PatientScoreRow[];
  totalReadings: number;
  /** Cases whose reference is a real bedside monitor. */
  monitorCases: number;
  /** Cases scored against a clinical annotation instead. */
  annotationCases: number;
  casesWithModel: number;
  casesWithAge: number;
  /** Median per-case COEBIS MAE across cases that have a model and enough readings. */
  medianMae: number | null;
  /** Cases where any reading reached the suppression threshold. */
  casesWithSuppression: number;
  lineages: string[];
}

const r1 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(1)));
const r2 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2)));

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const v = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  return Number.isFinite(v) ? v : null;
}

export function spreadOf(values: (number | null)[], dp = 1): Spread {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const round = (v: number | null) => (v == null ? null : Number(v.toFixed(dp)));
  return {
    median: round(quantile(nums, 0.5)),
    p10: round(quantile(nums, 0.1)),
    p90: round(quantile(nums, 0.9)),
    min: round(nums[0] ?? null),
    max: round(nums[nums.length - 1] ?? null),
  };
}

const meanOf = (values: (number | null)[]): number | null => {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
};

/** Keep at most `max` samples, evenly spaced, always keeping first and last. */
export function thinCaseSeries<T>(items: T[], max = MAX_CASE_SERIES): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]!);
  return out;
}

function referenceLabel(kind: ReferenceKind, monitor: string | null): string {
  if (kind === "monitor") return monitor ?? "bedside monitor";
  if (kind === "moaas-score") return "MOAA/S score";
  if (kind === "event-state") return "event-file state";
  return monitor ?? "unspecified reference";
}

function verdictFor(row: {
  reference: ReferenceMeta;
  hasModel: boolean;
  sufficient: boolean;
  readings: number;
  agreement: AgreementSummary | null;
  raw: AgreementSummary;
  maeGain: number | null;
  suppression: PatientScoreRow["suppression"];
}): string {
  const parts: string[] = [];
  if (!row.sufficient) {
    parts.push(
      `Only ${row.readings} reading${row.readings === 1 ? "" : "s"} in this case — below the ${MIN_CASE_READINGS} needed to read the agreement figures as describing the case.`,
    );
  }
  if (!row.hasModel) {
    parts.push(
      `No promoted COEBIS model for this setup, so the figures are the open index: it sits ${describeBias(row.raw.bias)} the reference.`,
    );
  } else if (row.sufficient) {
    const mae = row.agreement?.mae;
    parts.push(
      `COEBIS lands ${mae == null ? "an unmeasured distance" : `${mae.toFixed(1)} points`} from the reference on average and sits ${describeBias(row.agreement?.bias ?? null)} it.`,
    );
    if (row.maeGain != null) {
      parts.push(
        row.maeGain > 0
          ? `The model improves on the open index by ${row.maeGain.toFixed(1)} points here.`
          : `The model is ${Math.abs(row.maeGain).toFixed(1)} points worse than the open index here.`,
      );
    }
  }
  if (!row.reference.isMonitor) {
    parts.push(`Reference is a ${row.reference.label}, not a BIS monitor, so this is not a BIS comparison.`);
  }
  if ((row.suppression.burdenPct ?? 0) >= 10) {
    parts.push(
      `${row.suppression.burdenPct!.toFixed(0)}% of readings are suppressed, where any depth index compresses — read the agreement inside that band separately.`,
    );
  }
  return parts.join(" ");
}

function describeBias(bias: number | null): string {
  if (bias == null) return "at an unmeasured offset from";
  if (Math.abs(bias) < 1) return "level with";
  return bias > 0 ? `${bias.toFixed(1)} points above` : `${Math.abs(bias).toFixed(1)} points below`;
}

export interface PatientLineageModel {
  model: CoebisModel;
  version: number | null;
}

/** Build one scoreboard row per case, scored under its own lineage's live model. */
export function buildPatientRows(
  readings: PatientReadingInput[],
  models: Map<string, PatientLineageModel>,
): PatientScoreRow[] {
  const byCase = new Map<string, PatientReadingInput[]>();
  for (const r of readings) {
    if (!Number.isFinite(r.reference) || !Number.isFinite(r.appIndex)) continue;
    const list = byCase.get(r.caseKey);
    if (list) list.push(r);
    else byCase.set(r.caseKey, [r]);
  }

  const rows: PatientScoreRow[] = [];
  for (const [caseKey, list] of byCase) {
    const points = [...list].sort((a, b) => a.at - b.at);
    const first = points[0]!;
    const lineageKey = first.lineageKey ?? "unattributed";
    const lineageModel = models.get(lineageKey) ?? null;

    const scored = points.map((p) => ({
      point: p,
      // Never use the in-sample case intercept here: this page is read as
      // "what would COEBIS have shown for this patient", which for a case the
      // model has already seen must not borrow that case's own offset.
      coebis: lineageModel ? predictCoebis(lineageModel.model, { appIndex: p.appIndex, cov: p.cov, ce: p.ce }, false) : null,
    }));

    const agreement = lineageModel
      ? agreementSummary(
          scored
            .filter((s) => s.coebis != null)
            .map((s) => ({ predicted: s.coebis!, bis: s.point.reference })),
        )
      : null;
    const raw = agreementSummary(points.map((p) => ({ predicted: p.appIndex, bis: p.reference })));
    const maeGain =
      agreement?.mae != null && raw.mae != null ? Number((raw.mae - agreement.mae).toFixed(2)) : null;

    const srValues = points.map((p) => p.appSr);
    const measuredSr = srValues.filter((v): v is number => v != null && Number.isFinite(v));
    const refSrValues = points.map((p) => p.refSr);
    const measuredRefSr = refSrValues.filter((v): v is number => v != null && Number.isFinite(v));

    const kind = first.referenceKind;
    const reference: ReferenceMeta = {
      ...REFERENCE_META[kind],
      label: referenceLabel(kind, first.monitor),
    };

    const suppression = {
      meanPct: r1(meanOf(srValues)),
      maxPct: r1(measuredSr.length ? Math.max(...measuredSr) : null),
      burdenPct: measuredSr.length
        ? r1((measuredSr.filter((v) => v >= SUPPRESSION_PCT_THRESHOLD).length / measuredSr.length) * 100)
        : null,
      referenceMeanPct: r1(meanOf(refSrValues)),
      referenceBurdenPct: measuredRefSr.length
        ? r1((measuredRefSr.filter((v) => v >= SUPPRESSION_PCT_THRESHOLD).length / measuredRefSr.length) * 100)
        : null,
    };

    const ageYears = first.ageYears;
    const ageBand = first.cov?.ageBand ?? null;
    const sufficient = points.length >= MIN_CASE_READINGS;

    const row: PatientScoreRow = {
      caseKey,
      caseLabel: first.caseLabel,
      lineageKey,
      modelVersion: lineageModel?.version ?? null,
      hasModel: Boolean(lineageModel),
      reference,
      readings: points.length,
      reliableReadings: points.filter((p) => p.reliable).length,
      firstAt: points.reduce((a, p) => (p.recordedAt < a ? p.recordedAt : a), first.recordedAt),
      lastAt: points.reduce((a, p) => (p.recordedAt > a ? p.recordedAt : a), first.recordedAt),
      spanSeconds: Math.round(points[points.length - 1]!.at - first.at),
      age: {
        years: ageYears,
        band: ageBand,
        source: ageYears != null || ageBand ? "case-record" : "not-published",
      },
      sex: first.cov?.sex ?? null,
      regimen: first.cov?.regimen ?? null,
      coebis: spreadOf(scored.map((s) => s.coebis)),
      referenceSpread: spreadOf(points.map((p) => p.reference)),
      suppression,
      sef95: {
        app: spreadOf(points.map((p) => p.appSef), 2),
        referenceMedian: spreadOf(points.map((p) => p.refSef), 2).median,
      },
      agreement,
      raw,
      maeGain,
      sufficient,
      verdict: "",
      divergence: divergenceOf(
        scored.map(({ point, coebis }) => ({
          at: point.at,
          reference: point.reference,
          displayed: coebis ?? point.appIndex,
          sr: point.appSr,
        })),
        lineageModel ? "coebis" : "open-index",
      ),
      series: thinCaseSeries(
        scored.map(({ point, coebis }) => ({
          at: Math.round(point.at),
          reference: r1(point.reference)!,
          raw: r1(point.appIndex)!,
          coebis: r1(coebis),
          sr: r2(point.appSr),
          sef: r2(point.appSef),
          refSr: r2(point.refSr),
          refSef: r2(point.refSef),
          gap: r1((coebis ?? point.appIndex) - point.reference),
        })),
      ),

    };
    row.verdict = verdictFor(row);
    rows.push(row);
  }

  return rows.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/** Cohort-level counts. Deliberately no pooled agreement: references differ. */
export function summarisePatientCohort(rows: PatientScoreRow[]): PatientCohort {
  const maes = rows
    .filter((r) => r.sufficient && r.agreement?.mae != null)
    .map((r) => r.agreement!.mae!)
    .sort((a, b) => a - b);
  return {
    rows,
    totalReadings: rows.reduce((sum, r) => sum + r.readings, 0),
    monitorCases: rows.filter((r) => r.reference.isMonitor).length,
    annotationCases: rows.filter((r) => !r.reference.isMonitor).length,
    casesWithModel: rows.filter((r) => r.hasModel).length,
    casesWithAge: rows.filter((r) => r.age.source === "case-record").length,
    medianMae: maes.length ? Number(quantile(maes, 0.5)!.toFixed(2)) : null,
    casesWithSuppression: rows.filter((r) => (r.suppression.maxPct ?? 0) >= SUPPRESSION_PCT_THRESHOLD)
      .length,
    lineages: [...new Set(rows.map((r) => r.lineageKey))].sort(),
  };
}
