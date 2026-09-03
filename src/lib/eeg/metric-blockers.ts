/**
 * Plain-language explanations for why a performance metric could not be
 * computed, with the exact counts that caused the block.
 *
 * Blank "—" cells on the Model performance page must never be ambiguous: a
 * reviewer should be able to read whether the gap is missing paired
 * EEG-index↔reference readings, too few cases for leave-one-case-out scoring,
 * or a single-version lineage with nothing to drift from. Every explanation
 * names the counts behind the block so the remedy (import more paired data)
 * is obvious.
 */

import type { ModelVersionRow, LineageHistory } from "./coebis-refit.functions";
import type { LineageDrift } from "./coebis-drift";
import type { BisDriftAnalysis } from "./bis-drift";

export interface MetricBlocker {
  /** Metric that is missing, e.g. "After MAE". */
  metric: string;
  /** Why it is missing, including the counts that caused the block. */
  reason: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Why before/after MAE (and therefore the gain) is blank for a recorded
 * model version in the refit pipeline.
 */
export function explainVersionMetricGaps(v: ModelVersionRow): MetricBlocker[] {
  const blockers: MetricBlocker[] = [];
  const n = v.training.n ?? 0;
  const cases = v.training.cases ?? 0;

  if (v.before.mae == null) {
    blockers.push({
      metric: "Before MAE",
      reason:
        `No paired EEG-index↔reference readings were available to score the prior state ` +
        `(${v.before.n ?? 0} readings). Import sessions where the app depth index and a ` +
        `reference (e.g. transcribed BIS) exist at the same moment.`,
    });
  }
  if (v.after.mae == null) {
    blockers.push(
      cases < 2
        ? {
            metric: "After MAE (held out)",
            reason:
              `Leave-one-case-out scoring needs readings from at least 2 cases; this fit had ` +
              `${plural(n, "reading")} across ${plural(cases, "case")}, so the candidate ` +
              `could not be held-out scored.`,
          }
        : {
            metric: "After MAE (held out)",
            reason:
              `The candidate was not held-out scored despite ${plural(n, "reading")} across ` +
              `${plural(cases, "case")} — the refit stopped early (${v.reason ?? "no reason recorded"}).`,
          },
    );
  }
  if (v.maeGain == null && (v.before.mae == null) !== (v.after.mae == null)) {
    blockers.push({
      metric: "Gain",
      reason: "Gain needs both a before and an after MAE; one side is missing (see above).",
    });
  }
  return blockers;
}

/**
 * Why Δ MAE / weight drift is blank for a lineage in the drift-vs-baseline
 * panel. Distinguishes "only one version exists" from "a version was never
 * scored on paired readings".
 */
export function explainDriftGaps(lineage: LineageHistory, d: LineageDrift): MetricBlocker[] {
  const blockers: MetricBlocker[] = [];
  const versions = lineage.versions.length;

  if (d.maeDelta == null) {
    if (versions < 2) {
      blockers.push({
        metric: "Δ MAE",
        reason:
          `Only ${plural(versions, "model version")} recorded for this lineage — drift needs at ` +
          `least one refit (2 versions) to compare against the original fit.`,
      });
    } else if (d.baselineMae == null) {
      blockers.push({
        metric: "Δ MAE",
        reason:
          `The baseline version has no held-out MAE — it was recorded without paired ` +
          `EEG-index↔reference scoring, so the current model's MAE ` +
          `(${d.currentMae == null ? "also missing" : d.currentMae.toFixed(2)}) has nothing to compare against.`,
      });
    } else {
      const current = d.current;
      blockers.push({
        metric: "Δ MAE",
        reason:
          `The current model has no held-out MAE: it was fitted on ` +
          `${plural(current?.training.n ?? 0, "reading")} across ` +
          `${plural(current?.training.cases ?? 0, "case")} without leave-one-case-out scoring ` +
          `(baseline MAE ${d.baselineMae.toFixed(2)} is available).`,
      });
    }
  }
  if (d.maxWeightDrift == null && versions < 2) {
    blockers.push({
      metric: "Weight drift",
      reason:
        `Needs two versions with fitted weights; only the baseline exists ` +
        `(${plural(versions, "version")} recorded).`,
    });
  }
  return blockers;
}

/**
 * Why pooled agreement metrics (MAE, correlation) are blank in the
 * COEBIS/BIS drift watch.
 */
export function explainAgreementGaps(a: BisDriftAnalysis): MetricBlocker[] {
  const blockers: MetricBlocker[] = [];
  if (a.mae == null) {
    blockers.push({
      metric: "Mean offset / abs. error",
      reason:
        `No usable paired EEG-index↔BIS readings yet (${a.n} paired across ` +
        `${plural(a.sessions, "case")}). Agreement metrics can only be computed where both ` +
        `the app index and a transcribed monitor value exist at the same moment — missing ` +
        `paired EEG index values are the usual cause.`,
    });
  } else if (a.r == null) {
    blockers.push({
      metric: "Pearson r",
      reason:
        `Correlation needs at least 3 paired readings; only ${a.n} available across ` +
        `${plural(a.sessions, "case")}.`,
    });
  }
  return blockers;
}
