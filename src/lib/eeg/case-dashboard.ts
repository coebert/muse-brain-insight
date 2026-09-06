/**
 * Case dashboard — depth, suppression and outcome for each bedside case, side
 * by side and over time.
 *
 * Everything here is descriptive. With a handful of cases no comparison
 * between recoveries is a finding, so the module reports counts alongside each
 * number and marks a trend as thin until there are enough cases to read it.
 */

import type { CaseOutcome, OutcomeCase } from "./outcomes";

/** A trend needs at least this many cases in a period before it is readable. */
export const MIN_TREND_CASES = 3;

export type OutcomeFlag = "clear" | "adverse" | "unrecorded";

export interface CaseRow extends OutcomeCase {
  startedAt: string | null;
  /** Share of the case spent with any suppression, 0–100. */
  suppressedPercent: number;
  /** Share of the case spent below a depth index of 40, 0–100. */
  deepPercent: number;
  /** Whether anything adverse was recorded after the case. */
  flag: OutcomeFlag;
  /** Short labels for whatever went wrong, empty when nothing did. */
  adverse: string[];
}

export interface TrendPoint {
  /** Month key, YYYY-MM. */
  period: string;
  label: string;
  cases: number;
  meanDepth: number | null;
  meanSuppressedPercent: number;
  meanMinutesSuppressed: number;
  meanMinutesDeep: number;
  adverse: number;
  outcomesRecorded: number;
  /** False while the period holds too few cases to read. */
  readable: boolean;
}

export interface CaseDashboard {
  rows: CaseRow[];
  trend: TrendPoint[];
  totals: {
    cases: number;
    outcomesRecorded: number;
    adverse: number;
    meanDepth: number | null;
    meanSuppressedPercent: number;
    minutesSuppressed: number;
  };
}

const round = (v: number, dp = 1) => Number(v.toFixed(dp));

/** Adverse events recorded after a case, in the clinician's own words. */
export function adverseEvents(outcome: CaseOutcome | null): string[] {
  if (!outcome) return [];
  const out: string[] = [];
  if (outcome.delirium !== "unknown" && outcome.delirium !== "none") out.push("Delirium");
  if (outcome.emergence !== "unknown" && outcome.emergence !== "smooth")
    out.push(outcome.emergence === "delayed" ? "Delayed waking" : "Agitated waking");
  if (outcome.awareness) out.push("Awareness");
  if (outcome.unplannedIcu) out.push("Unplanned intensive care");
  if (outcome.mortality30d) out.push("Died within 30 days");
  return out;
}

/** Whether an outcome was recorded at all, and whether anything went wrong. */
export function outcomeFlag(outcome: CaseOutcome | null): OutcomeFlag {
  if (!outcome) return "unrecorded";
  if (adverseEvents(outcome).length) return "adverse";
  const assessed =
    outcome.delirium !== "unknown" ||
    outcome.emergence !== "unknown" ||
    outcome.lengthOfStayDays != null;
  return assessed ? "clear" : "unrecorded";
}

function monthLabel(period: string): string {
  const [y, m] = period.split("-");
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

/**
 * Build the dashboard: one row per case, newest first, plus a month-by-month
 * trend of depth and suppression exposure with the adverse-outcome count.
 */
export function buildCaseDashboard(cases: OutcomeCase[]): CaseDashboard {
  const rows: CaseRow[] = cases.map((c) => {
    const minutes = c.durationMinutes > 0 ? c.durationMinutes : 0;
    return {
      ...c,
      startedAt: (c as OutcomeCase & { startedAt?: string | null }).startedAt ?? null,
      suppressedPercent: minutes ? round((c.minutesSuppressed / minutes) * 100) : 0,
      deepPercent: minutes ? round((c.minutesDeep / minutes) * 100) : 0,
      flag: outcomeFlag(c.outcome),
      adverse: adverseEvents(c.outcome),
    };
  });

  rows.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  const byPeriod = new Map<string, CaseRow[]>();
  for (const row of rows) {
    if (!row.startedAt) continue;
    const period = row.startedAt.slice(0, 7);
    byPeriod.set(period, [...(byPeriod.get(period) ?? []), row]);
  }

  const trend: TrendPoint[] = [...byPeriod.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, list]) => {
      const depths = list.map((r) => r.meanDepth).filter((v): v is number => v != null);
      const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
      return {
        period,
        label: monthLabel(period),
        cases: list.length,
        meanDepth: depths.length ? round(avg(depths)) : null,
        meanSuppressedPercent: round(avg(list.map((r) => r.suppressedPercent))),
        meanMinutesSuppressed: round(avg(list.map((r) => r.minutesSuppressed))),
        meanMinutesDeep: round(avg(list.map((r) => r.minutesDeep))),
        adverse: list.filter((r) => r.flag === "adverse").length,
        outcomesRecorded: list.filter((r) => r.flag !== "unrecorded").length,
        readable: list.length >= MIN_TREND_CASES,
      };
    });

  const depths = rows.map((r) => r.meanDepth).filter((v): v is number => v != null);
  return {
    rows,
    trend,
    totals: {
      cases: rows.length,
      outcomesRecorded: rows.filter((r) => r.flag !== "unrecorded").length,
      adverse: rows.filter((r) => r.flag === "adverse").length,
      meanDepth: depths.length ? round(depths.reduce((a, b) => a + b, 0) / depths.length) : null,
      meanSuppressedPercent: rows.length
        ? round(rows.reduce((a, b) => a + b.suppressedPercent, 0) / rows.length)
        : 0,
      minutesSuppressed: round(rows.reduce((a, b) => a + b.minutesSuppressed, 0)),
    },
  };
}
