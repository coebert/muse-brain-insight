/**
 * Live accuracy of the COEBIS score, per acquisition lineage.
 *
 * The model catalogue reports how a version scored *when it was fitted*. This
 * module answers the different question the ward actually asks: how does the
 * score in force right now agree with the monitor across every validated
 * reading held today, including readings recorded since the last refit.
 *
 * Nothing here fits or promotes anything. Where a lineage has no model, the
 * uncorrected published index is scored and labelled as such rather than
 * dressed up as a COEBIS result.
 */

import { MIN_POINTS, MIN_SESSIONS } from "./bis-drift";
import {
  agreementSummary,
  predictCoebis,
  type AgreementSummary,
  type CoebisModel,
  type CoebisTrainingPoint,
} from "./coebis-covariates";
import { selectValidatedPoints } from "./coebis-refit";

/** What the reported metrics were measured on. */
export type AccuracySource = "model" | "raw_index";

export interface LineageLiveAccuracy {
  lineageKey: string;
  /** Validated readings behind the metrics. */
  n: number;
  cases: number;
  /** Readings offered but rejected by the training filters. */
  rejected: number;
  /** Agreement of whatever is in force for this lineage right now. */
  current: AgreementSummary;
  /** Agreement of the uncorrected published index, as the standing comparator. */
  raw: AgreementSummary;
  source: AccuracySource;
  /** Live model version, when one is in force. */
  activeVersion: number | null;
  modelFamily: string | null;
  /** MAE the model takes off the uncorrected index; negative means it adds error. */
  maeGain: number | null;
  cccGain: number | null;
  gate: {
    cleared: boolean;
    points: { have: number; need: number };
    cases: { have: number; need: number };
  };
  newestReadingAt: string | null;
  /** Readings recorded after the last completed refit run for this owner. */
  readingsSinceRefit: number;
  /** Set when the lineage cannot be fitted yet. */
  blockedReason: string | null;
}

export interface LiveAccuracyReport {
  lineages: LineageLiveAccuracy[];
  lastRefitAt: string | null;
  /** Whether the scheduled job is running or has been paused. */
  schedulerStatus: string;
  schedulerNote: string | null;
  /** How often the scheduled tick fires, in minutes. */
  tickMinutes: number;
  generatedAt: string;
  gate: { minPoints: number; minCases: number };
}

function round(v: number | null, dp = 3): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

/** Score one lineage's readings against the model currently in force. */
export function liveAccuracyForLineage(
  lineageKey: string,
  points: CoebisTrainingPoint[],
  incumbent: { model: CoebisModel; version: number | null } | null,
  lastRefitAt: string | null,
): LineageLiveAccuracy {
  const validated = selectValidatedPoints(points);
  const used = validated.used;
  const cases = new Set(used.map((p) => p.sessionId ?? "unfiled")).size;

  const raw = agreementSummary(used.map((p) => ({ predicted: p.appIndex, bis: p.bis })));
  const current = incumbent
    ? agreementSummary(
        // Per-case intercepts stay out: they are fitted quantities, and using
        // them here would score the model on cases it already memorised.
        used.map((p) => ({ predicted: predictCoebis(incumbent.model, p, false), bis: p.bis })),
      )
    : raw;

  const times = used
    .map((p) => p.recordedAt)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .sort();
  const newestReadingAt = times[times.length - 1] ?? null;
  const cutoff = lastRefitAt ? new Date(lastRefitAt).getTime() : null;
  const readingsSinceRefit =
    cutoff == null ? used.length : times.filter((t) => new Date(t).getTime() > cutoff).length;

  const cleared = used.length >= MIN_POINTS && cases >= MIN_SESSIONS;

  return {
    lineageKey,
    n: used.length,
    cases,
    rejected: points.length - used.length,
    current,
    raw,
    source: incumbent ? "model" : "raw_index",
    activeVersion: incumbent?.version ?? null,
    modelFamily: incumbent?.model.family ?? null,
    maeGain:
      incumbent && current.mae != null && raw.mae != null ? round(raw.mae - current.mae, 3) : null,
    cccGain:
      incumbent && current.ccc != null && raw.ccc != null ? round(current.ccc - raw.ccc, 3) : null,
    gate: {
      cleared,
      points: { have: used.length, need: MIN_POINTS },
      cases: { have: cases, need: MIN_SESSIONS },
    },
    newestReadingAt,
    readingsSinceRefit,
    blockedReason: cleared
      ? null
      : `Needs ${MIN_POINTS} validated readings across ${MIN_SESSIONS} cases to cross-validate; has ${used.length} across ${cases}.`,
  };
}

/** Group readings by lineage and score each one, busiest lineage first. */
export function summariseLiveAccuracy(
  points: CoebisTrainingPoint[],
  incumbents: Map<string, { model: CoebisModel; version: number | null }>,
  meta: {
    lastRefitAt: string | null;
    schedulerStatus?: string;
    schedulerNote?: string | null;
    tickMinutes?: number;
    generatedAt?: string;
  },
): LiveAccuracyReport {
  const byLineage = new Map<string, CoebisTrainingPoint[]>();
  for (const p of points) {
    const key = p.lineageKey ?? "unrecorded";
    byLineage.set(key, [...(byLineage.get(key) ?? []), p]);
  }

  const lineages = [...byLineage.entries()]
    .map(([key, list]) =>
      liveAccuracyForLineage(key, list, incumbents.get(key) ?? null, meta.lastRefitAt),
    )
    .sort((a, b) => Number(b.gate.cleared) - Number(a.gate.cleared) || b.n - a.n);

  return {
    lineages,
    lastRefitAt: meta.lastRefitAt,
    schedulerStatus: meta.schedulerStatus ?? "unknown",
    schedulerNote: meta.schedulerNote ?? null,
    tickMinutes: meta.tickMinutes ?? 15,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    gate: { minPoints: MIN_POINTS, minCases: MIN_SESSIONS },
  };
}

export function emptyLiveAccuracy(): LiveAccuracyReport {
  return summariseLiveAccuracy([], new Map(), { lastRefitAt: null });
}
