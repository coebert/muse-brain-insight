/**
 * One case, read three ways at once.
 *
 * The depth trace, the suppression flag and the ketamine signature are built
 * by three separate pipelines that never share a fit. This module puts one
 * case's view of all three into a single record so they can be read side by
 * side, and lines two cases up for comparison.
 *
 * Nothing here fits or corrects anything: it selects, matches and subtracts
 * already-computed numbers. Where a case carries no evidence on an axis the
 * field is null and the page must say so rather than imply agreement.
 */

import {
  caseTrace,
  type CaseTrace,
  type ModelSource,
} from "./suppression-dashboard";
import type { SuppressionModel, SuppressionPoint } from "./suppression-model";
import type { KetamineCaseSummary } from "./ketamine-cases";

/** One case as it appears in the picker. */
export interface CaseOption {
  caseRef: string;
  /** Paired suppression readings held for it. */
  points: number;
  /** Readings that also carry a bedside monitor index. */
  bisPoints: number;
  /** Ketamine is named in this case's record. */
  ketamineDeclared: boolean;
}

/** Everything one case contributes to the three axes. */
export interface CaseFile {
  caseRef: string;
  /** Depth and suppression on one clock; null when no paired reading exists. */
  trace: CaseTrace | null;
  /** The ketamine signature, or null when the case has no spectra held. */
  ketamine: KetamineCaseSummary | null;
  /** Which calibration produced the suppression estimates on this trace. */
  modelSource: ModelSource;
}

/** A single number on both cases, with the difference between them. */
export interface CaseDelta {
  label: string;
  /** Higher is better for this measure; null when direction is not meaningful. */
  higherIsBetter: boolean | null;
  a: number | null;
  b: number | null;
  delta: number | null;
  /** Formatting hint for the page: points, percent or a plain count. */
  unit: "points" | "percent" | "count";
}

export interface CaseComparison {
  a: string;
  b: string;
  rows: CaseDelta[];
  /** Axes where one case carries evidence and the other does not. */
  notes: string[];
}

function round(v: number | null, dp = 1): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

/**
 * Match a suppression case reference to a ketamine summary.
 *
 * The two pipelines name cases from different source columns, so an exact
 * match is tried first and a containment match only afterwards. Ambiguous
 * containment — more than one candidate — returns null rather than guessing,
 * because attaching another patient's drug record to this trace would be worse
 * than showing nothing.
 */
export function matchKetamine(
  caseRef: string,
  summaries: KetamineCaseSummary[],
): KetamineCaseSummary | null {
  const exact = summaries.find((s) => s.caseRef === caseRef);
  if (exact) return exact;
  const ref = caseRef.toLowerCase();
  const loose = summaries.filter((s) => {
    const other = s.caseRef.toLowerCase();
    return other === ref || other.includes(ref) || ref.includes(other);
  });
  return loose.length === 1 ? (loose[0] as KetamineCaseSummary) : null;
}

/** Group paired readings by case, ready for the picker and the traces. */
export function groupByCase(points: SuppressionPoint[]): Map<string, SuppressionPoint[]> {
  const byCase = new Map<string, SuppressionPoint[]>();
  for (const p of points) {
    const list = byCase.get(p.caseRef);
    if (list) list.push(p);
    else byCase.set(p.caseRef, [p]);
  }
  return byCase;
}

/** Every case that can be opened, busiest first. */
export function caseOptions(
  points: SuppressionPoint[],
  summaries: KetamineCaseSummary[],
): CaseOption[] {
  const byCase = groupByCase(points);
  const options: CaseOption[] = [...byCase.entries()].map(([caseRef, rows]) => ({
    caseRef,
    points: rows.length,
    bisPoints: rows.filter((r) => r.bis != null).length,
    ketamineDeclared: matchKetamine(caseRef, summaries)?.declared ?? false,
  }));
  // Ketamine cases held without any paired reading still deserve an entry, so
  // the picker does not hide the very cases the signature panel exists for.
  for (const s of summaries) {
    if (options.some((o) => o.caseRef === s.caseRef)) continue;
    if (matchKetamine(s.caseRef, summaries) && byCase.has(s.caseRef)) continue;
    if ([...byCase.keys()].some((ref) => matchKetamine(ref, summaries)?.caseRef === s.caseRef)) {
      continue;
    }
    options.push({
      caseRef: s.caseRef,
      points: 0,
      bisPoints: 0,
      ketamineDeclared: s.declared,
    });
  }
  return options.sort((a, b) => b.points - a.points || a.caseRef.localeCompare(b.caseRef));
}

/** Assemble one case's file from the readings and spectra already loaded. */
export function buildCaseFile(
  caseRef: string,
  points: SuppressionPoint[],
  model: SuppressionModel | null,
  summaries: KetamineCaseSummary[],
  modelSource: ModelSource = model ? "candidate fit" : "raw detector",
): CaseFile {
  const rows = groupByCase(points).get(caseRef) ?? [];
  return {
    caseRef,
    trace: rows.length ? caseTrace(caseRef, rows, model) : null,
    ketamine: matchKetamine(caseRef, summaries),
    modelSource,
  };
}

function row(
  label: string,
  unit: CaseDelta["unit"],
  higherIsBetter: boolean | null,
  a: number | null,
  b: number | null,
): CaseDelta {
  const ra = round(a);
  const rb = round(b);
  return {
    label,
    unit,
    higherIsBetter,
    a: ra,
    b: rb,
    delta: ra == null || rb == null ? null : round(rb - ra),
  };
}

/**
 * Line two cases up measure by measure.
 *
 * A missing number on either side leaves the difference null: two cases graded
 * on different evidence are not comparable, and quietly treating an absent
 * label as a zero would make the thinner case look better than it is.
 */
export function compareCases(a: CaseFile, b: CaseFile): CaseComparison {
  const rows: CaseDelta[] = [
    row("Mean COEBIS", "points", null, a.trace?.meanIndex ?? null, b.trace?.meanIndex ?? null),
    row(
      "Mean COEBIS after cap",
      "points",
      null,
      a.trace?.meanCappedIndex ?? null,
      b.trace?.meanCappedIndex ?? null,
    ),
    row("Mean BIS", "points", null, a.trace?.bis.meanBis ?? null, b.trace?.bis.meanBis ?? null),
    row(
      "Off the monitor by",
      "points",
      false,
      a.trace?.bis.maeRaw ?? null,
      b.trace?.bis.maeRaw ?? null,
    ),
    row(
      "Monitor suppression ratio",
      "percent",
      null,
      a.trace?.meanMonitorSr ?? null,
      b.trace?.meanMonitorSr ?? null,
    ),
    row(
      "Model suppression estimate",
      "percent",
      null,
      a.trace?.meanEstimatedSr ?? null,
      b.trace?.meanEstimatedSr ?? null,
    ),
    row(
      "Suppression the app missed",
      "count",
      false,
      a.trace?.flags.missed ?? null,
      b.trace?.flags.missed ?? null,
    ),
    row(
      "Readings the cap moved",
      "count",
      null,
      a.trace?.capEngaged ?? null,
      b.trace?.capEngaged ?? null,
    ),
    row(
      "Ketamine pattern strength",
      "count",
      null,
      a.ketamine?.meanScore ?? null,
      b.ketamine?.meanScore ?? null,
    ),
    row(
      "Mean ketamine correction",
      "points",
      null,
      a.ketamine?.meanDelta ?? null,
      b.ketamine?.meanDelta ?? null,
    ),
  ];

  const notes: string[] = [];
  if (!a.trace || !b.trace) {
    notes.push(
      `No paired monitor reading held for ${!a.trace ? a.caseRef : b.caseRef}, so the depth and suppression rows cannot be compared.`,
    );
  } else if (!a.trace.bis.n || !b.trace.bis.n) {
    notes.push(
      `No bedside index recorded on ${!a.trace.bis.n ? a.caseRef : b.caseRef}, so the monitor rows are left blank rather than scored.`,
    );
  }
  if (!a.ketamine || !b.ketamine) {
    notes.push(
      `No spectra held for ${!a.ketamine ? a.caseRef : b.caseRef}, so its ketamine signature is unknown.`,
    );
  } else if (a.ketamine.declared !== b.ketamine.declared) {
    const declared = a.ketamine.declared ? a.caseRef : b.caseRef;
    const other = a.ketamine.declared ? b.caseRef : a.caseRef;
    notes.push(
      `Ketamine is recorded on ${declared} but not on ${other}: the correction is live on one case and advisory only on the other, so the two signature rows are not like for like.`,
    );
  }

  return { a: a.caseRef, b: b.caseRef, rows, notes };
}
