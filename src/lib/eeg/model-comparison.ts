/**
 * Shared model vs headband-only model vs the outcome cohort, side by side.
 *
 * Three different things are being compared and they answer different
 * questions, so they are never merged into one score:
 *
 *  - the shared model: COEBIS as fitted on the research corpora (VitalDB,
 *    figshare, OpenNeuro), graded against those monitors;
 *  - the headband-only model: fitted on the Muse/Regul8 readings alone,
 *    graded against the bedside monitor on held-out cases;
 *  - the outcome cohort: depth and suppression exposure set against what
 *    actually happened to the patient.
 *
 * Everything here is pure arithmetic over already-computed reports. Nothing
 * is fitted, and every pooled figure carries the count it was pooled from so
 * a two-case arm is never read as a finding.
 */

import type { CohortContrast } from "./case-outcomes";
import { isHeadbandLineage } from "./headband-fit";
import { MIN_COMPARISON_CASES, MIN_COMPARISON_POINTS, type LineageComparison } from "./lineage-comparison";
import type { SuppressionDashboard } from "./suppression-dashboard";

export type ArmKey = "shared" | "headband";

/** Readings below this and the suppression flag numbers are not readable. */
export const MIN_FLAG_EVENTS = 20;

export interface DepthArm {
  key: ArmKey;
  label: string;
  /** Acquisition setups pooled into this arm. */
  lineages: string[];
  /** Setups in this arm that have a promoted model. */
  modelled: number;
  points: number;
  cases: number;
  /** Mean gap to the monitor under the arm's models, in index points. */
  modelMae: number | null;
  /** Mean gap to the monitor for the open index on the same readings. */
  rawMae: number | null;
  /** rawMae − modelMae; positive means the models help. */
  gain: number | null;
  /** Share of readings within 5 / 10 points of the monitor, 0–1. */
  within5: number | null;
  within10: number | null;
  /** Signed mean difference; positive means the model reads lighter. */
  bias: number | null;
  /** Enough readings and cases for the arm's numbers to describe the setup. */
  readable: boolean;
}

const r2 = (v: number | null): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2));

/** Weighted mean of a per-lineage field, weighted by that lineage's n. */
function pooled(
  rows: { n: number; value: number | null }[],
): number | null {
  let sum = 0;
  let weight = 0;
  for (const row of rows) {
    if (row.value == null || !Number.isFinite(row.value) || row.n <= 0) continue;
    sum += row.value * row.n;
    weight += row.n;
  }
  return weight > 0 ? sum / weight : null;
}

function armOf(lineageKey: string): ArmKey | null {
  if (lineageKey === "unattributed") return null;
  return isHeadbandLineage(lineageKey) ? "headband" : "shared";
}

const ARM_LABELS: Record<ArmKey, string> = {
  shared: "Shared model (research corpora)",
  headband: "Headband-only model (Muse / Regul8)",
};

/**
 * Pool each acquisition setup's prediction-vs-reality summary into its arm.
 * Readings with no setup recorded are left out of both arms rather than
 * flattering either one.
 */
export function buildDepthArms(lineages: LineageComparison[]): DepthArm[] {
  const arms: ArmKey[] = ["shared", "headband"];
  return arms.map((key) => {
    const members = lineages.filter((l) => armOf(l.lineageKey) === key);
    const points = members.reduce((s, l) => s + l.points, 0);
    const cases = members.reduce((s, l) => s + l.cases, 0);
    const modelled = members.filter((l) => l.hasModel).length;

    const modelRows = members
      .filter((l) => l.coebis != null)
      .map((l) => ({ n: l.coebis!.n, summary: l.coebis! }));
    const rawRows = members.map((l) => ({ n: l.raw.n, summary: l.raw }));

    const modelMae = r2(pooled(modelRows.map((r) => ({ n: r.n, value: r.summary.mae }))));
    const rawMae = r2(pooled(rawRows.map((r) => ({ n: r.n, value: r.summary.mae }))));

    return {
      key,
      label: ARM_LABELS[key],
      lineages: members.map((l) => l.lineageKey),
      modelled,
      points,
      cases,
      modelMae,
      rawMae,
      gain: modelMae != null && rawMae != null ? r2(rawMae - modelMae) : null,
      within5: r2(pooled(modelRows.map((r) => ({ n: r.n, value: r.summary.within5 })))),
      within10: r2(pooled(modelRows.map((r) => ({ n: r.n, value: r.summary.within10 })))),
      bias: r2(pooled(modelRows.map((r) => ({ n: r.n, value: r.summary.bias })))),
      readable:
        modelled > 0 && points >= MIN_COMPARISON_POINTS && cases >= MIN_COMPARISON_CASES,
    };
  });
}

/** How the suppression flag stands against the monitor's own suppression. */
export interface SuppressionScore {
  /** Readings carrying a monitor suppression ratio. */
  n: number;
  /** Moments the monitor called suppressed. */
  monitorEvents: number;
  /** Of those, the ones the app also flagged, and the ones it missed. */
  caught: number;
  missed: number;
  /** Of those, how many the app also flagged, 0–1. */
  sensitivity: number | null;
  /** App flags with no monitor suppression, as a share of app flags, 0–1. */
  falseAlarmRate: number | null;
  /** Both flags in agreement, as a share of all readings, 0–1. */
  agreement: number | null;
  /** Mean gap between COEBIS and the monitor index, after the cap. */
  cappedMae: number | null;
  /** Same gap before the cap, so the cap can be seen to help or hurt. */
  rawMae: number | null;
  readable: boolean;
}

export function suppressionScore(dashboard: SuppressionDashboard | null): SuppressionScore {
  const totals = dashboard?.totals ?? { agreed: 0, missed: 0, falseAlarms: 0, clear: 0 };
  const n = totals.agreed + totals.missed + totals.falseAlarms + totals.clear;
  const monitorEvents = totals.agreed + totals.missed;
  const appFlags = totals.agreed + totals.falseAlarms;
  return {
    n,
    monitorEvents,
    caught: totals.agreed,
    missed: totals.missed,
    sensitivity: monitorEvents > 0 ? r2(totals.agreed / monitorEvents) : null,
    falseAlarmRate: appFlags > 0 ? r2(totals.falseAlarms / appFlags) : null,
    agreement: n > 0 ? r2((totals.agreed + totals.clear) / n) : null,
    cappedMae: dashboard?.bisTotals.maeCapped ?? null,
    rawMae: dashboard?.bisTotals.maeRaw ?? null,
    readable: monitorEvents >= MIN_FLAG_EVENTS,
  };
}

/** One outcome contrast, flattened for a grouped bar chart. */
export interface OutcomeBar {
  label: string;
  /** Mean minutes below 40 in each arm. */
  withDeep: number | null;
  withoutDeep: number | null;
  /** Mean minutes suppressed in each arm. */
  withSuppressed: number | null;
  withoutSuppressed: number | null;
  withN: number;
  withoutN: number;
  underpowered: boolean;
}

export function outcomeBars(contrasts: CohortContrast[]): OutcomeBar[] {
  return contrasts.map((c) => ({
    label: c.label,
    withDeep: c.withMinutesBelow40,
    withoutDeep: c.withoutMinutesBelow40,
    withSuppressed: c.withMinutesSuppressed,
    withoutSuppressed: c.withoutMinutesSuppressed,
    withN: c.withN,
    withoutN: c.withoutN,
    underpowered: c.underpowered,
  }));
}

/** Plain-language reading of how the two depth arms compare. */
export function depthVerdict(arms: DepthArm[]): string {
  const shared = arms.find((a) => a.key === "shared");
  const headband = arms.find((a) => a.key === "headband");
  if (!shared?.modelMae && !headband?.modelMae) {
    return "No promoted depth model has enough paired readings yet to compare.";
  }
  const parts: string[] = [];
  if (shared?.modelMae != null) {
    parts.push(
      `the shared model sits ${shared.modelMae.toFixed(1)} points from the monitor across ${shared.points.toLocaleString()} readings`,
    );
  }
  if (headband?.modelMae != null) {
    parts.push(
      `the headband-only model sits ${headband.modelMae.toFixed(1)} points away across ${headband.points.toLocaleString()} readings${headband.readable ? "" : " — too few to read as settled"}`,
    );
  }
  return `${parts.join(", and ")}.`;
}
