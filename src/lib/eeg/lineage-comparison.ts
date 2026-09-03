/**
 * COEBIS against the real monitor, one lineage at a time (pure core).
 *
 * Pooling every acquisition setup into one agreement number hides the thing
 * that matters: a model fitted on one headband/montage may track the monitor
 * well there and badly elsewhere. This builds a prediction-vs-reality series
 * and agreement summary per lineage, never across lineages, and always states
 * how the open index alone would have done on the same readings.
 */

import {
  agreementSummary,
  predictCoebis,
  type AgreementSummary,
  type CoebisModel,
  type CoebisTrainingPoint,
} from "./coebis-covariates";

/** Points below this cannot support an agreement claim for a lineage. */
export const MIN_COMPARISON_POINTS = 12;
/** Cases below this mean the numbers describe one or two patients, not a setup. */
export const MIN_COMPARISON_CASES = 2;
/** Series points kept per lineage, so a long lineage still renders cheaply. */
export const MAX_SERIES_POINTS = 240;

export interface ComparisonSample {
  /** Epoch milliseconds of the reading. */
  t: number;
  /** Monitor value as recorded. */
  bis: number;
  /** COEBIS prediction under the lineage's live model. */
  coebis: number | null;
  /** Open index before any COEBIS correction. */
  raw: number;
  caseId: string | null;
  reliable: boolean;
}

export interface LineageComparison {
  lineageKey: string;
  /** Whether a promoted COEBIS model exists for this lineage. */
  hasModel: boolean;
  modelFamily: string | null;
  modelVersion: number | null;
  points: number;
  cases: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Monitor devices the readings were paired against, as filed. */
  monitors: string[];
  /** Downsampled prediction-vs-reality series, oldest first. */
  series: ComparisonSample[];
  /** COEBIS vs monitor. Null when this lineage has no model. */
  coebis: AgreementSummary | null;
  /** Open index vs monitor, on exactly the same readings. */
  raw: AgreementSummary;
  /** raw MAE − COEBIS MAE; positive = the model helps here. */
  maeGain: number | null;
  /** Enough data to read the agreement numbers as describing the setup. */
  sufficient: boolean;
  /** Plain reading of what this lineage shows. */
  verdict: string;
}

export interface LineageModel {
  model: CoebisModel;
  version: number | null;
}

const r2 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2));

/** Keep at most `max` samples, evenly spaced, always keeping first and last. */
export function thinSeries<T>(items: T[], max = MAX_SERIES_POINTS): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]!);
  return out;
}

function verdictFor(
  hasModel: boolean,
  sufficient: boolean,
  coebis: AgreementSummary | null,
  raw: AgreementSummary,
  gain: number | null,
): string {
  if (!hasModel) {
    return `No promoted COEBIS model for this setup — the app shows the open index, which sits ${describeBias(raw.bias)} the monitor.`;
  }
  if (!sufficient) {
    return `Too few paired readings here (${raw.n} across ${MIN_COMPARISON_CASES > 1 ? "few" : "one"} cases) to judge agreement — shown for inspection only.`;
  }
  const bias = describeBias(coebis?.bias ?? null);
  const within = coebis?.within5 == null ? null : Math.round(coebis.within5 * 100);
  const help =
    gain == null
      ? "not comparable against the open index"
      : gain > 0.25
        ? `${gain.toFixed(2)} index points better than the open index`
        : gain < -0.25
          ? `${Math.abs(gain).toFixed(2)} index points worse than the open index`
          : "no better than the open index";
  return `COEBIS sits ${bias} the monitor${within == null ? "" : `, ${within}% of readings within 5 points`} — ${help}.`;
}

function describeBias(bias: number | null): string {
  if (bias == null) return "at an unknown offset from";
  if (Math.abs(bias) < 0.5) return "level with";
  return `${Math.abs(bias).toFixed(1)} points ${bias > 0 ? "lighter than" : "deeper than"}`;
}

/**
 * Build one prediction-vs-reality comparison per acquisition lineage. Readings
 * without a lineage are grouped under `unattributed` rather than being folded
 * into a real setup.
 */
export function buildLineageComparisons(
  points: CoebisTrainingPoint[],
  models: Map<string, LineageModel>,
  monitorOf?: (p: CoebisTrainingPoint) => string | null,
): LineageComparison[] {
  const groups = new Map<string, CoebisTrainingPoint[]>();
  for (const p of points) {
    if (!Number.isFinite(p.bis) || !Number.isFinite(p.appIndex)) continue;
    const key = p.lineageKey ?? "unattributed";
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const out: LineageComparison[] = [];
  for (const [lineageKey, raw] of groups) {
    const sorted = [...raw].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const entry = models.get(lineageKey) ?? null;
    const model = entry?.model ?? null;

    const samples: ComparisonSample[] = sorted.map((p) => ({
      t: new Date(p.recordedAt).getTime(),
      bis: p.bis,
      coebis: model ? Number(predictCoebis(model, p).toFixed(1)) : null,
      raw: p.appIndex,
      caseId: p.sessionId ?? null,
      reliable: p.reliable,
    }));

    const rawAgreement = agreementSummary(samples.map((s) => ({ predicted: s.raw, bis: s.bis })));
    const coebisAgreement = model
      ? agreementSummary(
          samples
            .filter((s) => s.coebis != null)
            .map((s) => ({ predicted: s.coebis!, bis: s.bis })),
        )
      : null;
    const cases = new Set(sorted.map((p) => p.sessionId ?? "unfiled")).size;
    const sufficient =
      sorted.length >= MIN_COMPARISON_POINTS && cases >= MIN_COMPARISON_CASES && !!model;
    const maeGain =
      coebisAgreement?.mae != null && rawAgreement.mae != null
        ? r2(rawAgreement.mae - coebisAgreement.mae)
        : null;
    const monitors = monitorOf
      ? [...new Set(sorted.map((p) => monitorOf(p)).filter((m): m is string => !!m))].sort()
      : [];

    out.push({
      lineageKey,
      hasModel: !!model,
      modelFamily: model?.family ?? null,
      modelVersion: entry?.version ?? null,
      points: sorted.length,
      cases,
      firstAt: sorted[0]?.recordedAt ?? null,
      lastAt: sorted[sorted.length - 1]?.recordedAt ?? null,
      monitors,
      series: thinSeries(samples),
      coebis: coebisAgreement,
      raw: rawAgreement,
      maeGain,
      sufficient,
      verdict: verdictFor(!!model, sufficient, coebisAgreement, rawAgreement, maeGain),
    });
  }

  // Busiest setups first; unattributed readings last whatever their count.
  return out.sort((a, b) => {
    if (a.lineageKey === "unattributed") return 1;
    if (b.lineageKey === "unattributed") return -1;
    return b.points - a.points;
  });
}
