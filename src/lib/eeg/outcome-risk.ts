/**
 * Outcome estimates for a bedside case, read off the outcome cohort.
 *
 * The method is deliberately plain: take the case's depth and suppression
 * exposure, find the cohort recordings whose exposure looks most like it, and
 * report what happened to those patients — how many needed intensive care, how
 * long they stayed, how many died — with an interval around every rate.
 *
 * What this is NOT: a validated risk model. The cohort is unadjusted for how
 * sick or how big the operation was, the match uses exposure alone, and a
 * neighbourhood of a few dozen recordings gives wide intervals. Every figure
 * here is "what happened to similar exposures", never "what will happen to
 * this patient". The readable flags exist so a two-case difference is never
 * shown as a finding.
 */

import type { CohortCase } from "./case-outcomes";
import { LONG_STAY_DAYS, MIN_ARM } from "./case-outcomes";

/** Share of the cohort used as the matched neighbourhood. */
const NEIGHBOUR_SHARE = 0.3;

/** Exposure summary of the case being placed. */
export interface RiskInput {
  caseRef: string;
  label: string;
  /** Length of the recording, minutes. */
  minutes: number;
  meanIndex: number | null;
  minutesBelow40: number;
  minutesSuppressed: number;
}

export interface RateEstimate {
  key: "icu" | "death" | "longStay";
  label: string;
  /** Neighbours whose outcome is recorded. */
  matched: number;
  events: number;
  /** Share of matched neighbours with the outcome, 0-1. */
  rate: number | null;
  low: number | null;
  high: number | null;
  /** The same share across the whole cohort, for comparison. */
  cohortRate: number | null;
  readable: boolean;
}

export interface DaysEstimate {
  key: "icuDays" | "hospitalDays";
  label: string;
  matched: number;
  median: number | null;
  /** Middle 80% of the matched neighbours. */
  low: number | null;
  high: number | null;
  cohortMedian: number | null;
  readable: boolean;
}

export interface RiskPrediction {
  input: RiskInput;
  /** Cohort recordings with usable exposure. */
  cohortCases: number;
  /** How many of those were matched to this case. */
  neighbours: number;
  /** Position of this case's exposure in the cohort, 0-100. */
  percentileBelow40: number | null;
  percentileSuppressed: number | null;
  rates: RateEstimate[];
  days: DaysEstimate[];
  /** False when no neighbourhood arm is big enough to read. */
  readable: boolean;
  headline: string;
}

const round = (v: number, dp = 1) => Number(v.toFixed(dp));

function fractions(input: RiskInput): { deep: number; suppressed: number } {
  const minutes = input.minutes > 0 ? input.minutes : 0;
  return {
    deep: minutes ? Math.min(input.minutesBelow40 / minutes, 1) : 0,
    suppressed: minutes ? Math.min(input.minutesSuppressed / minutes, 1) : 0,
  };
}

function sd(values: number[]): number {
  if (values.length < 2) return 1;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) || 1;
}

/** Wilson score interval — honest at small counts, unlike the normal one. */
export function wilson(events: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = events / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (centre - spread) / denom),
    high: Math.min(1, (centre + spread) / denom),
  };
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const value = lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  return round(value);
}

function percentileOf(value: number, values: number[]): number | null {
  if (!values.length) return null;
  return Math.round((values.filter((v) => v <= value).length / values.length) * 100);
}

type Met = (c: CohortCase) => boolean | null;

const metIcu: Met = (c) => (c.outcome?.icuDays == null ? null : c.outcome.icuDays > 0);
const metDeath: Met = (c) => c.outcome?.inHospitalDeath ?? null;
const metLongStay: Met = (c) =>
  c.outcome?.hospitalDays == null ? null : c.outcome.hospitalDays >= LONG_STAY_DAYS;

function rateOf(
  key: RateEstimate["key"],
  label: string,
  neighbours: CohortCase[],
  all: CohortCase[],
  met: Met,
): RateEstimate {
  const scored = neighbours.map(met).filter((v): v is boolean => v != null);
  const cohortScored = all.map(met).filter((v): v is boolean => v != null);
  const matched = scored.length;
  const events = scored.filter(Boolean).length;
  const interval = wilson(events, matched);
  return {
    key,
    label,
    matched,
    events,
    rate: matched ? events / matched : null,
    low: interval?.low ?? null,
    high: interval?.high ?? null,
    cohortRate: cohortScored.length
      ? cohortScored.filter(Boolean).length / cohortScored.length
      : null,
    readable: matched >= MIN_ARM,
  };
}

function daysOf(
  key: DaysEstimate["key"],
  label: string,
  neighbours: CohortCase[],
  all: CohortCase[],
  pick: (c: CohortCase) => number | null,
): DaysEstimate {
  const values = neighbours
    .map(pick)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const cohortValues = all
    .map(pick)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  return {
    key,
    label,
    matched: values.length,
    median: quantile(values, 0.5),
    low: quantile(values, 0.1),
    high: quantile(values, 0.9),
    cohortMedian: quantile(cohortValues, 0.5),
    readable: values.length >= MIN_ARM,
  };
}

/**
 * Place one bedside case against the cohort and report what happened to the
 * recordings whose exposure most resembles it.
 */
export function predictOutcome(
  input: RiskInput,
  cases: CohortCase[],
): RiskPrediction | null {
  const usable = cases.filter((c) => c.exposure && c.exposure.minutes > 0 && c.outcome != null);
  if (!usable.length) return null;

  const target = fractions(input);
  const deepSd = sd(usable.map((c) => c.exposure.fractionBelow40));
  const suppSd = sd(usable.map((c) => c.exposure.fractionSuppressed));

  const ranked = usable
    .map((c) => ({
      c,
      d:
        ((c.exposure.fractionBelow40 - target.deep) / deepSd) ** 2 +
        ((c.exposure.fractionSuppressed - target.suppressed) / suppSd) ** 2,
    }))
    .sort((a, b) => a.d - b.d);

  const k = Math.min(usable.length, Math.max(MIN_ARM, Math.ceil(usable.length * NEIGHBOUR_SHARE)));
  const neighbours = ranked.slice(0, k).map((r) => r.c);

  const rates = [
    rateOf("icu", "Needed intensive care", neighbours, usable, metIcu),
    rateOf("longStay", `Stayed ${LONG_STAY_DAYS} days or more`, neighbours, usable, metLongStay),
    rateOf("death", "Died in hospital", neighbours, usable, metDeath),
  ];
  const days = [
    daysOf("icuDays", "Days in intensive care", neighbours, usable, (c) => c.outcome?.icuDays ?? null),
    daysOf(
      "hospitalDays",
      "Days in hospital",
      neighbours,
      usable,
      (c) => c.outcome?.hospitalDays ?? null,
    ),
  ];

  const icu = rates[0]!;
  const readable = rates.some((r) => r.readable);
  const headline =
    input.minutes <= 0
      ? "No readings in this case yet."
      : icu.rate == null || !icu.readable
        ? `Matched to ${neighbours.length} cohort recordings — too few with a recorded outcome to read a rate.`
        : `Of the ${icu.matched} cohort recordings with similar depth and suppression, ${icu.events} needed intensive care.`;

  return {
    input,
    cohortCases: usable.length,
    neighbours: neighbours.length,
    percentileBelow40: percentileOf(
      target.deep,
      usable.map((c) => c.exposure.fractionBelow40),
    ),
    percentileSuppressed: percentileOf(
      target.suppressed,
      usable.map((c) => c.exposure.fractionSuppressed),
    ),
    rates,
    days,
    readable,
    headline,
  };
}
