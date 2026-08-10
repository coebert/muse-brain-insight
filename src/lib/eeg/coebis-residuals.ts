/**
 * Residual breakdown for the active COEBIS fit.
 *
 * The fit-quality chip gives one grade for the whole model; this says *where*
 * the model is failing — which residual sizes dominate, which depth bands and
 * cases drift, and whether agreement is improving or degrading over time.
 *
 * Everything here is measured from the actual residuals (COEBIS − commercial
 * BIS) of paired readings, so unlike the estimated in-fit chip these are
 * observed percentages, not a normal approximation.
 */
import { BIS_BANDS } from "./bis";

/** Agreement band (BIS units) a reading must fall inside to count as in-fit. */
export const RESIDUAL_TOLERANCE = 5;

export interface ResidualInput {
  /** COEBIS − commercial BIS, in index points. */
  residual: number;
  /** Commercial BIS value the reading was paired with. */
  bis: number;
  /** ISO timestamp the reading was filed. */
  recordedAt: string;
  /** Case label, for the worst-case ranking. */
  caseCode: string;
  /** Whether the reading is inside the set the fit was made on. */
  usedInFit: boolean;
}

export interface ResidualBin {
  /** Inclusive lower edge, in index points. */
  from: number;
  /** Exclusive upper edge. */
  to: number;
  label: string;
  n: number;
  /** Share of all residuals in this bin, 0–100. */
  percent: number;
}

export interface ResidualBucket {
  /** Bucket key, an ISO date (YYYY-MM-DD). */
  key: string;
  n: number;
  withinTolerance: number;
  percentWithin: number;
  bias: number | null;
  mae: number | null;
}

export interface ResidualGroup {
  label: string;
  n: number;
  withinTolerance: number;
  percentWithin: number;
  bias: number | null;
  mae: number | null;
}

export interface CoebisResiduals {
  n: number;
  withinTolerance: number;
  /** Observed share within ±tolerance, 0–100. */
  percentWithin: number;
  tolerance: number;
  bias: number | null;
  mae: number | null;
  /** Root-mean-square residual, sensitive to the tail the MAE hides. */
  rmse: number | null;
  /** Largest absolute residual seen. */
  worstAbs: number | null;
  /** Residuals beyond ±2× tolerance. */
  outliers: number;
  histogram: ResidualBin[];
  /** Agreement per calendar day, oldest first. */
  overTime: ResidualBucket[];
  /** Agreement per commercial-BIS depth band. */
  byBand: ResidualGroup[];
  /** Cases ranked by worst agreement (weakest first), min 3 readings. */
  byCase: ResidualGroup[];
}

const EDGES = [-Infinity, -15, -10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10, 15, Infinity];

const r1 = (v: number) => Number(v.toFixed(1));
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

function edgeLabel(from: number, to: number): string {
  if (from === -Infinity) return `< ${to}`;
  if (to === Infinity) return `≥ +${from}`;
  const f = from > 0 ? `+${from}` : String(from);
  const t = to > 0 ? `+${to}` : String(to);
  return `${f} to ${t}`;
}

function summarise(values: number[], tolerance: number) {
  const within = values.filter((v) => Math.abs(v) <= tolerance).length;
  const avg = mean(values);
  const mae = mean(values.map(Math.abs));
  return {
    n: values.length,
    withinTolerance: within,
    percentWithin: values.length ? Math.round((within / values.length) * 100) : 0,
    bias: avg == null ? null : r1(avg),
    mae: mae == null ? null : r1(mae),
  };
}

/**
 * Break the residuals of the active model down by size, time, depth band and
 * case so a clinician can see where agreement is weakest.
 */
export function computeCoebisResiduals(
  input: ResidualInput[],
  tolerance = RESIDUAL_TOLERANCE,
): CoebisResiduals {
  const rows = input.filter((p) => Number.isFinite(p.residual));
  const values = rows.map((p) => p.residual);
  const base = summarise(values, tolerance);

  const histogram: ResidualBin[] = [];
  for (let i = 0; i < EDGES.length - 1; i += 1) {
    const from = EDGES[i]!;
    const to = EDGES[i + 1]!;
    const n = values.filter((v) => v >= from && v < to).length;
    histogram.push({
      from,
      to,
      label: edgeLabel(from, to),
      n,
      percent: values.length ? Math.round((n / values.length) * 1000) / 10 : 0,
    });
  }

  const byDay = new Map<string, number[]>();
  for (const p of rows) {
    const key = p.recordedAt.slice(0, 10);
    const list = byDay.get(key);
    if (list) list.push(p.residual);
    else byDay.set(key, [p.residual]);
  }
  const overTime: ResidualBucket[] = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, list]) => ({ key, ...summarise(list, tolerance) }));

  const byBand: ResidualGroup[] = BIS_BANDS.map((b) => {
    const list = rows.filter((p) => p.bis >= b.low && p.bis < b.high).map((p) => p.residual);
    return { label: b.label, ...summarise(list, tolerance) };
  });

  const byCaseMap = new Map<string, number[]>();
  for (const p of rows) {
    const list = byCaseMap.get(p.caseCode);
    if (list) list.push(p.residual);
    else byCaseMap.set(p.caseCode, [p.residual]);
  }
  const byCase: ResidualGroup[] = Array.from(byCaseMap.entries())
    .map(([label, list]) => ({ label, ...summarise(list, tolerance) }))
    .filter((c) => c.n >= 3)
    .sort((a, b) => a.percentWithin - b.percentWithin || (b.mae ?? 0) - (a.mae ?? 0))
    .slice(0, 12);

  const squared = mean(values.map((v) => v * v));
  const worst = values.length ? Math.max(...values.map(Math.abs)) : null;

  return {
    ...base,
    tolerance,
    rmse: squared == null ? null : r1(Math.sqrt(squared)),
    worstAbs: worst == null ? null : r1(worst),
    outliers: values.filter((v) => Math.abs(v) > tolerance * 2).length,
    histogram,
    overTime,
    byBand,
    byCase,
  };
}
