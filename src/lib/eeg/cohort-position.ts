/**
 * Where the case in front of you sits inside the outcome cohort.
 *
 * The cohort is a set of real surgical recordings whose depth exposure is
 * paired with what actually happened to the patient (intensive care, length of
 * stay, in-hospital death). This module places the running case's exposure
 * against that distribution.
 *
 * What it deliberately does NOT do: predict an outcome. The score below is a
 * position in a distribution of exposure, not a probability of harm. The
 * cohort is unadjusted for how sick or how big the case was, so deep
 * anaesthesia in it may be a marker of the patient rather than a cause of
 * anything. Everything here is worded to keep that distinction visible.
 */

import type { CohortCase, DepthExposure } from "./case-outcomes";
import { MIN_ARM } from "./case-outcomes";

export type ExposureBand = "typical" | "above" | "well-above";

export interface ExposurePlacement {
  /** Minutes of the running case at this exposure. */
  minutes: number;
  /** Share of cohort cases with no more exposure than this, 0-100. */
  percentile: number | null;
  /** Cohort median for the same measure, in minutes. */
  cohortMedian: number | null;
  /** Mean for cohort cases that needed intensive care, in minutes. */
  icuMean: number | null;
  /** Mean for cohort cases that did not, in minutes. */
  noIcuMean: number | null;
}

export interface CohortPosition {
  /** Cases in the cohort with usable exposure. */
  cohortCases: number;
  /** Cases whose outcome is recorded. */
  withOutcome: number;
  /** Cases that needed intensive care. */
  icuCases: number;
  /** False when either outcome arm is too small to read anything into. */
  readable: boolean;
  below40: ExposurePlacement;
  suppressed: ExposurePlacement;
  /** 0-100 position score: how deep and how suppressed, against the cohort. */
  score: number | null;
  band: ExposureBand;
  /** One plain sentence naming what the score means. */
  headline: string;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Share of values at or below `value`, as a percentage. */
export function percentileOf(value: number, values: number[]): number | null {
  if (!values.length) return null;
  const atOrBelow = values.filter((v) => v <= value).length;
  return Math.round((atOrBelow / values.length) * 100);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round1(
    sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
  );
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return round1(values.reduce((s, v) => s + v, 0) / values.length);
}

/** Did this cohort case need intensive care? Null when it is not recorded. */
function neededIcu(c: CohortCase): boolean | null {
  const days = c.outcome?.icuDays;
  return days == null ? null : days > 0;
}

function placement(
  minutes: number,
  values: number[],
  icuValues: number[],
  noIcuValues: number[],
): ExposurePlacement {
  return {
    minutes: round1(minutes),
    percentile: percentileOf(minutes, values),
    cohortMedian: median(values),
    icuMean: mean(icuValues),
    noIcuMean: mean(noIcuValues),
  };
}

function bandOf(score: number | null): ExposureBand {
  if (score == null) return "typical";
  if (score >= 85) return "well-above";
  if (score >= 60) return "above";
  return "typical";
}

/**
 * Place a running case's exposure against the cohort.
 *
 * `exposure` is normally built by `depthExposureOf` from the readings recorded
 * so far, so the position moves as the case goes on.
 */
export function cohortPosition(
  exposure: DepthExposure | null,
  cases: CohortCase[],
): CohortPosition | null {
  const usable = cases.filter((c) => c.exposure && c.exposure.minutes > 0);
  if (!usable.length) return null;

  const icu = usable.filter((c) => neededIcu(c) === true);
  const noIcu = usable.filter((c) => neededIcu(c) === false);
  const withOutcome = icu.length + noIcu.length;
  const readable = icu.length >= MIN_ARM && noIcu.length >= MIN_ARM;

  const below40 = placement(
    exposure?.minutesBelow40 ?? 0,
    usable.map((c) => c.exposure.minutesBelow40),
    icu.map((c) => c.exposure.minutesBelow40),
    noIcu.map((c) => c.exposure.minutesBelow40),
  );
  const suppressed = placement(
    exposure?.minutesSuppressed ?? 0,
    usable.map((c) => c.exposure.minutesSuppressed),
    icu.map((c) => c.exposure.minutesSuppressed),
    noIcu.map((c) => c.exposure.minutesSuppressed),
  );

  // Suppression carries the heavier weight: it is the exposure that separates
  // the intensive-care arm most clearly in this cohort, and it is the one a
  // clinician can act on immediately by lightening.
  const score =
    below40.percentile == null || suppressed.percentile == null
      ? null
      : Math.round(0.4 * below40.percentile + 0.6 * suppressed.percentile);
  const band = bandOf(score);

  const headline = !exposure
    ? "No readings yet in this case."
    : band === "well-above"
      ? `Deeper and more suppressed than ${score}% of the ${usable.length} cohort recordings.`
      : band === "above"
        ? `More exposure than ${score}% of the ${usable.length} cohort recordings.`
        : `In line with the ${usable.length} cohort recordings.`;

  return {
    cohortCases: usable.length,
    withOutcome,
    icuCases: icu.length,
    readable,
    below40,
    suppressed,
    score,
    band,
    headline,
  };
}
