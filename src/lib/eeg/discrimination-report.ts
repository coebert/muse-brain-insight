/**
 * Side-by-side discrimination and repeated-measures agreement for every depth
 * index the app can produce.
 *
 * This is how the depth-monitor literature judges an index: prediction
 * probability against ordered clinical states, ROC/AUC at the boundaries that
 * change management, and Bland-Altman limits that respect the fact that one
 * case contributes many readings. Correlation and pooled MAE — what the app
 * reported before — flatter an index that is merely on the right scale.
 *
 * Pure functions; the server function supplies the predictions.
 */

import { predictionProbability, rocAnalysis, type PkResult, type RocResult } from "./discrimination";
import { repeatedMeasuresBlandAltman, type RepeatedBlandAltman } from "./bland-altman";
import {
  DEPTH_BOUNDARIES,
  DEPTH_STATES,
  depthStateFromReference,
  type DepthState,
} from "./depth-states";

export interface DiscriminationPoint {
  /** Reference monitor value — defines the clinical state. */
  bis: number;
  /** Reference suppression ratio, when transcribed. */
  bisSr?: number | null;
  sessionId: string | null;
}

export interface IndexSeries {
  key: string;
  label: string;
  /** One value per point, aligned by position; null where unavailable. */
  values: (number | null)[];
  /**
   * True for the reference monitor itself. Its states are defined by its own
   * value, so its Pk/AUC are a ceiling rather than a result.
   */
  reference?: boolean;
}

export interface BoundaryResult {
  key: string;
  label: string;
  description: string;
  roc: RocResult;
}

export interface IndexDiscrimination {
  key: string;
  label: string;
  reference: boolean;
  n: number;
  pk: PkResult;
  boundaries: BoundaryResult[];
  /** Agreement against the reference, decomposed by case. Null for the reference itself. */
  blandAltman: RepeatedBlandAltman | null;
}

export interface StateCount {
  key: string;
  label: string;
  n: number;
}

export interface DiscriminationReport {
  n: number;
  cases: number;
  states: StateCount[];
  /** How many distinct states the data actually covers. */
  statesCovered: number;
  indices: IndexDiscrimination[];
  summary: string;
}

function emptyReport(reason: string): DiscriminationReport {
  return {
    n: 0,
    cases: 0,
    states: DEPTH_STATES.map((s) => ({ key: s.key, label: s.label, n: 0 })),
    statesCovered: 0,
    indices: [],
    summary: reason,
  };
}

export function buildDiscriminationReport(
  points: DiscriminationPoint[],
  series: IndexSeries[],
): DiscriminationReport {
  const labelled: { point: DiscriminationPoint; state: DepthState; i: number }[] = [];
  points.forEach((point, i) => {
    const state = depthStateFromReference(point.bis, point.bisSr ?? null);
    if (state) labelled.push({ point, state, i });
  });

  if (labelled.length < 6) {
    return emptyReport(
      "Discrimination needs at least six paired readings before it says anything; log a few more against the monitor.",
    );
  }

  const states = DEPTH_STATES.map((s) => ({
    key: s.key,
    label: s.label,
    n: labelled.filter((l) => l.state.key === s.key).length,
  }));
  const statesCovered = states.filter((s) => s.n > 0).length;
  const cases = new Set(labelled.map((l) => l.point.sessionId ?? "unfiled")).size;

  const indices: IndexDiscrimination[] = series.map((s) => {
    const rows = labelled
      .map((l) => ({ value: s.values[l.i] ?? null, state: l.state, point: l.point }))
      .filter((r): r is { value: number; state: DepthState; point: DiscriminationPoint } =>
        r.value != null && Number.isFinite(r.value),
      );

    const pk = predictionProbability(rows.map((r) => ({ value: r.value, rank: r.state.rank })));
    const boundaries = DEPTH_BOUNDARIES.map((b) => ({
      key: b.key,
      label: b.label,
      description: b.description,
      roc: rocAnalysis(rows.map((r) => ({ value: r.value, positive: b.positive(r.state) }))),
    })).filter((b) => b.roc.auc != null);

    const blandAltman = s.reference
      ? null
      : repeatedMeasuresBlandAltman(
          rows.map((r) => ({
            caseKey: r.point.sessionId ?? "unfiled",
            predicted: r.value,
            reference: r.point.bis,
          })),
        );

    return {
      key: s.key,
      label: s.label,
      reference: Boolean(s.reference),
      n: rows.length,
      pk,
      boundaries,
      blandAltman,
    };
  });

  const scored = indices
    .filter((i) => !i.reference && i.pk.pk != null)
    .sort((a, b) => (b.pk.pk ?? 0) - (a.pk.pk ?? 0));
  const best = scored[0];

  const coverage =
    statesCovered < 3
      ? ` Only ${statesCovered} of the four clinical states appear in the data, so this is a partial picture — readings from lighter and deeper moments would firm it up.`
      : "";

  const summary = best
    ? `Across ${labelled.length} readings from ${cases} case${cases === 1 ? "" : "s"}, ${best.label} separates the clinical states best with a prediction probability of ${best.pk.pk!.toFixed(3)}${
        best.pk.se != null ? ` ± ${(1.96 * best.pk.se).toFixed(3)}` : ""
      }. Clinical states are taken from the reference monitor, so its own row is a ceiling rather than a result.${coverage}`
    : `No index could be scored on these ${labelled.length} readings yet.${coverage}`;

  return { n: labelled.length, cases, states, statesCovered, indices, summary };
}
