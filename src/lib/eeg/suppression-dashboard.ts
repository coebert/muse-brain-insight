/**
 * Side-by-side view of the suppression flag and COEBIS, case by case.
 *
 * The suppression model and the depth index are fitted separately and are read
 * together only through the bounded cap in `pairWithCoebis`. This module turns
 * the paired readings into per-case traces so a clinician can see, on one time
 * axis, where the monitor recorded suppression, where the app raises its own
 * flag, and what the cap does to the depth number at those moments.
 *
 * Nothing here fits anything. It reads an already-fitted model and reports.
 */

import {
  MIN_FIT_CASES,
  MIN_FIT_POINTS,
  MIN_SUPPRESSED_POINTS,
  MONITOR_SUPPRESSED_PCT,
  pairWithCoebis,
  predictSr,
  type SuppressionFitReport,
  type SuppressionModel,
  type SuppressionPoint,
} from "./suppression-model";

/** Estimated SR at or above which the app raises its own suppression flag. */
export const APP_FLAG_PCT = MONITOR_SUPPRESSED_PCT;

/** Cases shown on the dashboard, longest first. */
export const MAX_DASHBOARD_CASES = 12;

/** Samples kept per case trace; longer records are thinned evenly. */
export const MAX_TRACE_SAMPLES = 240;

/** One point on a case trace, with both scores on the same clock. */
export interface TraceSample {
  /** Seconds into the recording. */
  at: number;
  /** COEBIS as fitted, before the suppression cap. */
  index: number | null;
  /** COEBIS after the bounded suppression cap. */
  cappedIndex: number | null;
  /** The commercial monitor's index, where one was recorded. */
  monitorIndex: number | null;
  /** The monitor's own suppression ratio, %. */
  monitorSr: number;
  /** The app's raw suppression detector, %. */
  appSr: number;
  /** The suppression model's estimate, %. */
  estimatedSr: number;
  /** Monitor says suppressed at this moment. */
  monitorFlag: boolean;
  /** App says suppressed at this moment. */
  appFlag: boolean;
}

/** How the two flags agree over one case. */
export interface FlagAgreement {
  /** Both flags up. */
  agreed: number;
  /** Monitor flagged, app did not — the dangerous miss. */
  missed: number;
  /** App flagged, monitor did not. */
  falseAlarms: number;
  /** Neither flagged. */
  clear: number;
}

/**
 * COEBIS against the monitor's own index, on the readings where both exist.
 *
 * Graded before and after the suppression cap so the cap can be seen to help
 * or hurt: it is only allowed to pull the number down, so a fall in error here
 * means it pulled down where the monitor also read deep.
 */
export interface BisAgreement {
  /** Readings carrying both a monitor index and a COEBIS score. */
  n: number;
  meanBis: number | null;
  meanIndex: number | null;
  meanCappedIndex: number | null;
  /** Mean absolute difference from the monitor, in index points. */
  maeRaw: number | null;
  maeCapped: number | null;
  /** Signed mean difference: positive means COEBIS reads lighter than BIS. */
  biasRaw: number | null;
  biasCapped: number | null;
  /** Readings the cap moved closer to the monitor, and further from it. */
  capImproved: number;
  capWorsened: number;
}

export interface CaseTrace {
  caseRef: string;
  points: number;
  /** Length of the record in seconds. */
  durationSeconds: number;
  flags: FlagAgreement;
  /** COEBIS against the real monitor index over this case. */
  bis: BisAgreement;
  /** Mean COEBIS across the case, before and after the cap. */
  meanIndex: number | null;
  meanCappedIndex: number | null;
  /** Mean suppression ratios, monitor versus the model's estimate. */
  meanMonitorSr: number;
  meanEstimatedSr: number;
  /** Readings where the cap moved the depth number at all. */
  capEngaged: number;
  /** Largest number of index points the cap removed in this case. */
  maxCapShift: number;
  /**
   * Readings inside recorded suppression where the depth number still read
   * light (>60) after the cap. These are the ones that would mislead.
   */
  falselyLight: number;
  samples: TraceSample[];
}


/** Whether the suppression fit is allowed to act, and what is missing if not. */
export interface GateStatus {
  lineage: string;
  points: number;
  cases: number;
  suppressedPoints: number;
  folds: number;
  requiredPoints: number;
  requiredCases: number;
  requiredSuppressedPoints: number;
  /** Model in force, or null when the gate has not been cleared. */
  active: boolean;
  promotable: boolean;
  blockedBy: string | null;
  sensitivityGain: number | null;
  maeGain: number | null;
}

export interface SuppressionDashboard {
  gate: GateStatus;
  /** Flag agreement summed over every case shown. */
  totals: FlagAgreement;
  cases: CaseTrace[];
}

const round = (v: number, dp = 1): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

const mean = (values: number[]): number | null =>
  values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;

/** Keep at most `max` samples, evenly spaced, always including the last one. */
export function thin<T>(rows: T[], max = MAX_TRACE_SAMPLES): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const row = rows[Math.floor(i * step)];
    if (row !== undefined) out.push(row);
  }
  const last = rows[rows.length - 1];
  if (last !== undefined && out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Running totals for the COEBIS-versus-BIS comparison.
 *
 * Kept as sums so a case and a whole cohort are summarised by the same code,
 * and so a patient with a long record cannot be averaged twice.
 */
export interface BisAccumulator {
  n: number;
  sumBis: number;
  sumIndex: number;
  sumCapped: number;
  sumAbsRaw: number;
  sumAbsCapped: number;
  sumSignedRaw: number;
  sumSignedCapped: number;
  capImproved: number;
  capWorsened: number;
}

export function newBisAccumulator(): BisAccumulator {
  return {
    n: 0,
    sumBis: 0,
    sumIndex: 0,
    sumCapped: 0,
    sumAbsRaw: 0,
    sumAbsCapped: 0,
    sumSignedRaw: 0,
    sumSignedCapped: 0,
    capImproved: 0,
    capWorsened: 0,
  };
}

export function addBisReading(
  acc: BisAccumulator,
  bis: number,
  index: number,
  cappedIndex: number,
): void {
  const rawErr = index - bis;
  const capErr = cappedIndex - bis;
  acc.n++;
  acc.sumBis += bis;
  acc.sumIndex += index;
  acc.sumCapped += cappedIndex;
  acc.sumAbsRaw += Math.abs(rawErr);
  acc.sumAbsCapped += Math.abs(capErr);
  acc.sumSignedRaw += rawErr;
  acc.sumSignedCapped += capErr;
  if (Math.abs(capErr) < Math.abs(rawErr) - 1e-9) acc.capImproved++;
  else if (Math.abs(capErr) > Math.abs(rawErr) + 1e-9) acc.capWorsened++;
}

export function mergeBis(into: BisAccumulator, from: BisAccumulator): void {
  into.n += from.n;
  into.sumBis += from.sumBis;
  into.sumIndex += from.sumIndex;
  into.sumCapped += from.sumCapped;
  into.sumAbsRaw += from.sumAbsRaw;
  into.sumAbsCapped += from.sumAbsCapped;
  into.sumSignedRaw += from.sumSignedRaw;
  into.sumSignedCapped += from.sumSignedCapped;
  into.capImproved += from.capImproved;
  into.capWorsened += from.capWorsened;
}

export function summariseBis(acc: BisAccumulator): BisAgreement {
  const avg = (sum: number): number | null => (acc.n ? round(sum / acc.n) : null);
  return {
    n: acc.n,
    meanBis: avg(acc.sumBis),
    meanIndex: avg(acc.sumIndex),
    meanCappedIndex: avg(acc.sumCapped),
    maeRaw: avg(acc.sumAbsRaw),
    maeCapped: avg(acc.sumAbsCapped),
    biasRaw: avg(acc.sumSignedRaw),
    biasCapped: avg(acc.sumSignedCapped),
    capImproved: acc.capImproved,
    capWorsened: acc.capWorsened,
  };
}

/** Turn one case's readings into a trace with both scores on one clock. */

export function caseTrace(
  caseRef: string,
  rows: SuppressionPoint[],
  model: SuppressionModel | null,
): CaseTrace {
  const ordered = [...rows].sort((a, b) => a.atSeconds - b.atSeconds);
  const flags: FlagAgreement = { agreed: 0, missed: 0, falseAlarms: 0, clear: 0 };
  const samples: TraceSample[] = [];
  const indices: number[] = [];
  const capped: number[] = [];
  const monitorSrs: number[] = [];
  const estimatedSrs: number[] = [];
  let capEngaged = 0;
  let maxCapShift = 0;
  let falselyLight = 0;
  const bisAcc = newBisAccumulator();

  for (const p of ordered) {
    const estimatedSr = model ? predictSr(model, p.appSr, p.appIndex) : p.appSr;
    const paired = p.appIndex == null ? null : pairWithCoebis(p.appIndex, estimatedSr);
    const monitorFlag = p.bisSr >= MONITOR_SUPPRESSED_PCT;
    const appFlag = estimatedSr >= APP_FLAG_PCT;

    if (monitorFlag && appFlag) flags.agreed++;
    else if (monitorFlag) flags.missed++;
    else if (appFlag) flags.falseAlarms++;
    else flags.clear++;

    if (paired?.engaged) capEngaged++;
    if (paired) maxCapShift = Math.max(maxCapShift, paired.shift);
    if (monitorFlag && paired && paired.cappedIndex > 60) falselyLight++;

    if (p.appIndex != null) indices.push(p.appIndex);
    if (paired) capped.push(paired.cappedIndex);
    monitorSrs.push(p.bisSr);
    estimatedSrs.push(estimatedSr);
    if (p.bis != null && p.appIndex != null && paired) {
      addBisReading(bisAcc, p.bis, p.appIndex, paired.cappedIndex);
    }

    samples.push({
      at: p.atSeconds,
      index: p.appIndex,
      cappedIndex: paired ? paired.cappedIndex : null,
      monitorIndex: p.bis,
      monitorSr: round(p.bisSr),
      appSr: round(p.appSr),
      estimatedSr: round(estimatedSr),
      monitorFlag,
      appFlag,
    });
  }

  const first = ordered[0]?.atSeconds ?? 0;
  const last = ordered[ordered.length - 1]?.atSeconds ?? 0;

  return {
    caseRef,
    points: ordered.length,
    durationSeconds: Math.max(0, last - first),
    flags,
    bis: summariseBis(bisAcc),
    meanIndex: mean(indices),
    meanCappedIndex: mean(capped),
    meanMonitorSr: mean(monitorSrs) ?? 0,
    meanEstimatedSr: mean(estimatedSrs) ?? 0,
    capEngaged,
    maxCapShift: round(maxCapShift),
    falselyLight,
    samples: thin(samples),
  };
}


/** Gate status read straight off the cross-validated fit. */
export function gateStatus(fit: SuppressionFitReport): GateStatus {
  return {
    lineage: fit.lineage,
    points: fit.points,
    cases: fit.cases,
    suppressedPoints: fit.suppressedPoints,
    folds: fit.folds,
    requiredPoints: MIN_FIT_POINTS,
    requiredCases: MIN_FIT_CASES,
    requiredSuppressedPoints: MIN_SUPPRESSED_POINTS,
    active: fit.promotable && fit.model != null,
    promotable: fit.promotable,
    blockedBy: fit.blockedBy,
    sensitivityGain: fit.sensitivityGain,
    maeGain: fit.maeGain,
  };
}

/**
 * Build the whole dashboard: the gate, the summed flag agreement and the
 * per-case traces, ranked by how much suppression the monitor recorded so the
 * cases that matter clinically come first.
 */
export function buildSuppressionDashboard(
  points: SuppressionPoint[],
  fit: SuppressionFitReport,
  maxCases = MAX_DASHBOARD_CASES,
): SuppressionDashboard {
  const byCase = new Map<string, SuppressionPoint[]>();
  for (const p of points) {
    const list = byCase.get(p.caseRef);
    if (list) list.push(p);
    else byCase.set(p.caseRef, [p]);
  }

  const traces = [...byCase.entries()]
    .map(([caseRef, rows]) => caseTrace(caseRef, rows, fit.model))
    .sort(
      (a, b) =>
        b.flags.agreed + b.flags.missed - (a.flags.agreed + a.flags.missed) ||
        b.points - a.points,
    )
    .slice(0, maxCases);

  const totals: FlagAgreement = { agreed: 0, missed: 0, falseAlarms: 0, clear: 0 };
  for (const t of traces) {
    totals.agreed += t.flags.agreed;
    totals.missed += t.flags.missed;
    totals.falseAlarms += t.flags.falseAlarms;
    totals.clear += t.flags.clear;
  }

  return { gate: gateStatus(fit), totals, cases: traces };
}
