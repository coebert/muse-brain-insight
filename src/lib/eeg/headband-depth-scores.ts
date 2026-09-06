/**
 * The headband-only depth score, set against the shared suppression model.
 *
 * The headband model is fitted on the Muse/Regul8 readings alone and produces
 * a 0–100 depth score. The suppression model is fitted separately, on the
 * VitalDB readings that carry a monitor suppression ratio, and produces an
 * estimated suppression percentage. They are independent: neither is trained
 * on the other's output.
 *
 * That independence is what makes the comparison worth reading. A depth score
 * is only credible if it goes deep exactly where the record goes flat, so
 * this module scores every headband epoch under both models and reports where
 * they agree, where they contradict each other, and what the suppression cap
 * does to the number when they disagree.
 *
 * Pure arithmetic: nothing here fits anything, and every figure carries the
 * count it came from.
 */

import { predictCoebis, type CoebisModel } from "./coebis-covariates";
import {
  MONITOR_SUPPRESSED_PCT,
  pairWithCoebis,
  predictSr,
  type SuppressionModel,
} from "./suppression-model";

/** Below this the headband score is calling the patient deep. */
export const DEEP_INDEX = 40;
/** At or above this it is calling the patient light. */
export const LIGHT_INDEX = 60;
/** Fewer scored epochs than this and a group's numbers are not readable. */
export const MIN_GROUP_EPOCHS = 30;

export interface HeadbandEpoch {
  sessionId: string;
  caseCode: string | null;
  atSeconds: number;
  /** The open index as recorded, 0–100. */
  rawIndex: number;
  /** App suppression ratio at that epoch, %. */
  appSr: number;
}

export interface ScoredEpoch {
  sessionId: string;
  atSeconds: number;
  rawIndex: number;
  /** Headband-only model score, 0–100. */
  headbandIndex: number;
  /** Shared suppression model's estimated monitor SR, %. */
  estimatedSr: number;
  /** Headband score after the suppression cap. */
  cappedIndex: number;
  capShift: number;
  suppressed: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const r2 = (v: number | null): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2));

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Score one epoch under both models. */
export function scoreEpoch(
  epoch: HeadbandEpoch,
  depth: CoebisModel | null,
  suppression: SuppressionModel | null,
): ScoredEpoch {
  const headbandIndex = depth
    ? clamp(predictCoebis(depth, { appIndex: epoch.rawIndex }, false), 0, 100)
    : clamp(epoch.rawIndex, 0, 100);
  const estimatedSr = suppression
    ? predictSr(suppression, epoch.appSr, epoch.rawIndex)
    : clamp(epoch.appSr, 0, 100);
  const paired = pairWithCoebis(headbandIndex, estimatedSr);
  return {
    sessionId: epoch.sessionId,
    atSeconds: epoch.atSeconds,
    rawIndex: Number(epoch.rawIndex.toFixed(1)),
    headbandIndex: Number(headbandIndex.toFixed(1)),
    estimatedSr: Number(estimatedSr.toFixed(1)),
    cappedIndex: paired.cappedIndex,
    capShift: paired.shift,
    suppressed: estimatedSr >= MONITOR_SUPPRESSED_PCT,
  };
}

export interface ScoreGroup {
  label: string;
  epochs: number;
  cases: number;
  /** Mean headband score in this group. */
  meanIndex: number | null;
  /** Mean open index, for reference. */
  meanRaw: number | null;
  /** Share of epochs the headband score calls deep, 0–1. */
  deepShare: number | null;
  readable: boolean;
}

export interface CaseScore {
  sessionId: string;
  caseCode: string | null;
  epochs: number;
  meanIndex: number | null;
  meanRaw: number | null;
  /** Epochs the suppression model called suppressed. */
  suppressedEpochs: number;
  /** Suppressed epochs the headband score did not call deep. */
  contradictions: number;
  /** Epochs where the suppression cap pulled the score down. */
  capped: number;
  meanCapShift: number | null;
}

export interface HeadbandScoreComparison {
  /** Whether a promoted headband model was applied, or the open index used. */
  depthSource: "headband_model" | "open_index";
  suppressionSource: "promoted" | "app_ratio";
  epochs: number;
  cases: number;
  meanIndex: number | null;
  meanRaw: number | null;
  /** Mean points the headband model moves the score by. */
  meanShift: number | null;
  suppressedEpochs: number;
  /** Suppressed epochs the headband score also calls deep, 0–1. */
  concordance: number | null;
  /** Suppressed epochs the headband score calls light, 0–1. */
  contradictionShare: number | null;
  /** Pearson correlation between estimated suppression and headband score. */
  correlation: number | null;
  cappedEpochs: number;
  meanCapShift: number | null;
  groups: ScoreGroup[];
  cases_: CaseScore[];
  /** Plain sentence about what the comparison does and does not show. */
  verdict: string;
}

function groupOf(label: string, rows: ScoredEpoch[]): ScoreGroup {
  return {
    label,
    epochs: rows.length,
    cases: new Set(rows.map((r) => r.sessionId)).size,
    meanIndex: r2(mean(rows.map((r) => r.headbandIndex))),
    meanRaw: r2(mean(rows.map((r) => r.rawIndex))),
    deepShare: rows.length
      ? r2(rows.filter((r) => r.headbandIndex < DEEP_INDEX).length / rows.length)
      : null,
    readable: rows.length >= MIN_GROUP_EPOCHS,
  };
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Score every headband epoch under both models and summarise the pairing. */
export function compareHeadbandToSuppression(
  epochs: HeadbandEpoch[],
  depth: CoebisModel | null,
  suppression: SuppressionModel | null,
): HeadbandScoreComparison {
  const scored = epochs.map((e) => scoreEpoch(e, depth, suppression));
  const codes = new Map(epochs.map((e) => [e.sessionId, e.caseCode] as const));
  const suppressedRows = scored.filter((s) => s.suppressed);
  const capped = scored.filter((s) => s.capShift > 0);

  const concordance = suppressedRows.length
    ? suppressedRows.filter((s) => s.headbandIndex < DEEP_INDEX).length / suppressedRows.length
    : null;
  const contradiction = suppressedRows.length
    ? suppressedRows.filter((s) => s.headbandIndex >= LIGHT_INDEX).length / suppressedRows.length
    : null;

  const byCase = new Map<string, ScoredEpoch[]>();
  for (const s of scored) {
    const rows = byCase.get(s.sessionId) ?? [];
    rows.push(s);
    byCase.set(s.sessionId, rows);
  }
  const caseScores: CaseScore[] = [...byCase.entries()]
    .map(([sessionId, rows]) => {
      const supp = rows.filter((r) => r.suppressed);
      const cappedRows = rows.filter((r) => r.capShift > 0);
      return {
        sessionId,
        caseCode: codes.get(sessionId) ?? null,
        epochs: rows.length,
        meanIndex: r2(mean(rows.map((r) => r.headbandIndex))),
        meanRaw: r2(mean(rows.map((r) => r.rawIndex))),
        suppressedEpochs: supp.length,
        contradictions: supp.filter((r) => r.headbandIndex >= LIGHT_INDEX).length,
        capped: cappedRows.length,
        meanCapShift: r2(mean(cappedRows.map((r) => r.capShift))),
      };
    })
    .sort((a, b) => b.suppressedEpochs - a.suppressedEpochs || b.epochs - a.epochs);

  const groups: ScoreGroup[] = [
    groupOf("Suppression model says suppressed", suppressedRows),
    groupOf("Suppression model says not suppressed", scored.filter((s) => !s.suppressed)),
  ];

  const verdict = !scored.length
    ? "No scored headband epochs to compare."
    : !suppressedRows.length
      ? `Across ${scored.length.toLocaleString()} headband epochs the suppression model found no suppression at all, so the two models cannot yet be checked against each other where it matters.`
      : concordance != null && concordance >= 0.6
        ? `Where the suppression model says the record is flat, the headband score goes deep ${Math.round(concordance * 100)}% of the time — the two independent models agree on the same moments.`
        : `Where the suppression model says the record is flat, the headband score goes deep only ${Math.round((concordance ?? 0) * 100)}% of the time. The headband score still reads too light at depth, which is exactly the weakness more paired readings need to fix.`;

  return {
    depthSource: depth ? "headband_model" : "open_index",
    suppressionSource: suppression ? "promoted" : "app_ratio",
    epochs: scored.length,
    cases: byCase.size,
    meanIndex: r2(mean(scored.map((s) => s.headbandIndex))),
    meanRaw: r2(mean(scored.map((s) => s.rawIndex))),
    meanShift: r2(mean(scored.map((s) => s.headbandIndex - s.rawIndex))),
    suppressedEpochs: suppressedRows.length,
    concordance: r2(concordance),
    contradictionShare: r2(contradiction),
    correlation: r2(
      pearson(scored.map((s) => s.estimatedSr), scored.map((s) => s.headbandIndex)),
    ),
    cappedEpochs: capped.length,
    meanCapShift: r2(mean(capped.map((s) => s.capShift))),
    groups,
    cases_: caseScores,
    verdict,
  };
}
