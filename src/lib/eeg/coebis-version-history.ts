/**
 * COEBIS model version history (pure helpers).
 *
 * Every refit already stores its coefficients, training summary and held-out
 * metrics. This turns a stored version into something a clinician or reviewer
 * can actually audit: what the model weights were, how they moved against the
 * version before it, and what the change bought in error terms. Nothing here
 * refits or promotes anything — it only reads history.
 */

import type { CoebisFamily } from "./coebis-covariates";
import { COVARIATE_LABELS } from "./covariates";

/** Coefficients as persisted in `coebis_model_versions.coefficients`. */
export interface StoredCoefficients {
  gain?: number;
  offset?: number;
  knots?: { x: number; dy: number }[];
  terms?: { group: string; level: string; dy: number; n?: number }[];
  ceTerms?: { drug: string; linear: number; curvature: number; n?: number }[];
  n?: number;
  sessions?: number;
}

export type WeightKind = "shape" | "covariate" | "drug";

export interface ModelWeight {
  /** Stable identity across versions, so weights line up when diffing. */
  id: string;
  kind: WeightKind;
  label: string;
  /** Index points (or gain/curvature, per `unit`). */
  value: number;
  unit: "index" | "gain" | "index@ce" | "curve";
  /** Readings the term was fitted on, when recorded. */
  n: number | null;
}

const GROUP_LABELS: Record<string, string> = {
  age: "Age band",
  ageBand: "Age band",
  sex: "Sex",
  regimen: "Regimen",
  frailty: "Frailty",
  pathology: "Pathology",
  setting: "Setting",
};

function groupLabel(group: string): string {
  return (
    GROUP_LABELS[group] ??
    (COVARIATE_LABELS as Record<string, string> | undefined)?.[group] ??
    group.replace(/([a-z])([A-Z])/g, "$1 $2")
  );
}

const round = (v: number, dp = 3) => Number(v.toFixed(dp));

/**
 * Flatten one stored model into labelled weights, ordered shape → covariate →
 * drug so two versions read down the same axis.
 */
export function describeWeights(
  family: CoebisFamily | string,
  coefficients: StoredCoefficients | null | undefined,
): ModelWeight[] {
  const c = coefficients ?? {};
  const out: ModelWeight[] = [];

  if (Number.isFinite(c.gain)) {
    out.push({
      id: "shape:gain",
      kind: "shape",
      label: "Gain on the open index",
      value: round(Number(c.gain)),
      unit: "gain",
      n: null,
    });
  }
  if (Number.isFinite(c.offset)) {
    out.push({
      id: "shape:offset",
      kind: "shape",
      label: "Offset",
      value: round(Number(c.offset), 2),
      unit: "index",
      n: null,
    });
  }
  for (const k of c.knots ?? []) {
    if (!Number.isFinite(k?.x) || !Number.isFinite(k?.dy)) continue;
    out.push({
      id: `shape:knot:${k.x}`,
      kind: "shape",
      label: `Shape at index ${k.x}`,
      value: round(k.dy, 2),
      unit: "index",
      n: null,
    });
  }
  for (const t of c.terms ?? []) {
    if (!t || !Number.isFinite(t.dy)) continue;
    out.push({
      id: `cov:${t.group}:${t.level}`,
      kind: "covariate",
      label: `${groupLabel(t.group)} · ${t.level}`,
      value: round(t.dy, 2),
      unit: "index",
      n: Number.isFinite(t.n) ? Number(t.n) : null,
    });
  }
  for (const t of c.ceTerms ?? []) {
    if (!t || !Number.isFinite(t.linear)) continue;
    out.push({
      id: `ce:${t.drug}:linear`,
      kind: "drug",
      label: `${t.drug} · concentration`,
      value: round(t.linear, 2),
      unit: "index@ce",
      n: Number.isFinite(t.n) ? Number(t.n) : null,
    });
    if (Number.isFinite(t.curvature) && t.curvature !== 0) {
      out.push({
        id: `ce:${t.drug}:curve`,
        kind: "drug",
        label: `${t.drug} · curvature`,
        value: round(t.curvature, 2),
        unit: "curve",
        n: Number.isFinite(t.n) ? Number(t.n) : null,
      });
    }
  }

  // The raw family carries no weights at all; make that explicit rather than
  // implying an empty covariate model.
  if (family === "raw") return out.filter((w) => w.kind === "shape");
  return out;
}

export interface WeightDelta extends ModelWeight {
  /** Previous version's value, or null when the term is new. */
  previous: number | null;
  /** value − previous, null when there is nothing to compare against. */
  delta: number | null;
  status: "added" | "removed" | "changed" | "same";
}

/**
 * Line up two versions' weights by term identity. Terms that disappeared are
 * kept with a zero value and a `removed` status so nothing silently vanishes
 * from the audit trail.
 */
export function diffWeights(current: ModelWeight[], previous: ModelWeight[] | null): WeightDelta[] {
  const before = new Map(previous?.map((w) => [w.id, w]) ?? []);
  const rows: WeightDelta[] = current.map((w) => {
    const prev = before.get(w.id);
    if (!prev) {
      return { ...w, previous: null, delta: null, status: previous ? "added" : "same" };
    }
    const delta = round(w.value - prev.value, 3);
    return {
      ...w,
      previous: prev.value,
      delta,
      status: delta === 0 ? "same" : "changed",
    };
  });
  const seen = new Set(current.map((w) => w.id));
  for (const w of previous ?? []) {
    if (seen.has(w.id)) continue;
    rows.push({
      ...w,
      value: 0,
      previous: w.value,
      delta: round(-w.value, 3),
      status: "removed",
    });
  }
  return rows;
}

export interface VersionMetrics {
  mae?: number | null;
  bias?: number | null;
  ccc?: number | null;
  n?: number;
  source?: string;
}

/**
 * One-line verdict for a stored version: what the refit changed and whether it
 * was allowed to go live. Deliberately plain — promotion already had to clear
 * the pipeline's gates, and history should not restate them as new evidence.
 */
export function versionVerdict(v: {
  promoted: boolean;
  isActive: boolean;
  maeGain: number | null;
  before: VersionMetrics;
  after: VersionMetrics;
}): string {
  const gain = v.maeGain;
  const movement =
    gain == null || !Number.isFinite(gain)
      ? "held-out error not comparable"
      : gain > 0
        ? `held-out MAE improved by ${gain.toFixed(2)}`
        : gain < 0
          ? `held-out MAE worsened by ${Math.abs(gain).toFixed(2)}`
          : "held-out MAE unchanged";
  if (v.isActive) return `Live model — ${movement}.`;
  if (v.promoted) return `Promoted when fitted, since superseded — ${movement}.`;
  return `Kept as a candidate only — ${movement}.`;
}

/** Compact description of the data a version was trained on. */
export function trainingSummary(t: {
  n?: number;
  cases?: number;
  folds?: number;
  passRate?: number;
}): string {
  const parts = [
    `${t.n ?? 0} validated readings`,
    `${t.cases ?? 0} cases`,
    t.folds ? `${t.folds} leave-one-case-out folds` : null,
    t.passRate != null && Number.isFinite(t.passRate)
      ? `${Math.round(t.passRate * 100)}% of offered readings passed validation`
      : null,
  ].filter(Boolean);
  return parts.join(" · ");
}
