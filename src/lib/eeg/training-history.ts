/**
 * Summaries for the training-history page.
 *
 * Honest naming matters here. COEBIS is not trained by gradient descent, so
 * there is no epoch-by-epoch loss curve to plot. What the pipeline does have,
 * and what this module surfaces, is:
 *
 *  - the settings each refit ran under (gate thresholds, shrinkage, folds);
 *  - the held-out error of every fitted version, in order — the closest thing
 *    to a learning curve, one point per refit rather than per epoch;
 *  - the per-fold score of a single fit, where each fold is one patient held
 *    entirely out — the closest thing to per-epoch scores.
 */

export interface VersionRow {
  lineage_key: string;
  version: number;
  model_family: string;
  promoted: boolean;
  is_active: boolean;
  mae_gain: number | null;
  reason: string | null;
  created_at: string;
  training: Record<string, unknown> | null;
  metrics_before: Record<string, unknown> | null;
  metrics_after: Record<string, unknown> | null;
  coefficients: Record<string, unknown> | null;
}

export interface VersionPoint {
  version: number;
  createdAt: string;
  family: string;
  promoted: boolean;
  isActive: boolean;
  readings: number;
  cases: number;
  folds: number;
  /** Held-out error before this candidate, in index points. */
  maeBefore: number | null;
  /** Held-out error of this candidate. */
  maeAfter: number | null;
  maeGain: number | null;
  cccAfter: number | null;
  within5After: number | null;
  biasAfter: number | null;
  /** Number of covariate terms the fit kept. */
  terms: number;
  reason: string | null;
}

export interface LineageHistory {
  lineageKey: string;
  versions: VersionPoint[];
  /** Held-out error of the model currently in force, if any. */
  activeMae: number | null;
  activeVersion: number | null;
  /** Best held-out error ever recorded for this setup. */
  bestMae: number | null;
  latestReadings: number;
  latestCases: number;
  promotions: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function metric(row: Record<string, unknown> | null, key: string): number | null {
  return row ? num(row[key]) : null;
}

export function toVersionPoint(row: VersionRow): VersionPoint {
  const training = row.training ?? {};
  const coefficients = row.coefficients ?? {};
  const terms = Array.isArray(coefficients["terms"]) ? (coefficients["terms"] as unknown[]).length : 0;
  const ceTerms = Array.isArray(coefficients["ceTerms"])
    ? (coefficients["ceTerms"] as unknown[]).length
    : 0;
  return {
    version: row.version,
    createdAt: row.created_at,
    family: row.model_family,
    promoted: row.promoted,
    isActive: row.is_active,
    readings: num(training["n"]) ?? 0,
    cases: num(training["cases"]) ?? num(training["sessions"]) ?? 0,
    folds: num(training["folds"]) ?? 0,
    maeBefore: metric(row.metrics_before, "mae"),
    maeAfter: metric(row.metrics_after, "mae"),
    maeGain: num(row.mae_gain),
    cccAfter: metric(row.metrics_after, "ccc"),
    within5After: metric(row.metrics_after, "within5"),
    biasAfter: metric(row.metrics_after, "bias"),
    terms: terms + ceTerms,
    reason: row.reason,
  };
}

/** Group every recorded fit by acquisition setup, oldest version first. */
export function buildLineageHistories(rows: VersionRow[]): LineageHistory[] {
  const byLineage = new Map<string, VersionPoint[]>();
  for (const row of rows) {
    const key = row.lineage_key;
    byLineage.set(key, [...(byLineage.get(key) ?? []), toVersionPoint(row)]);
  }
  const out: LineageHistory[] = [];
  for (const [lineageKey, list] of byLineage) {
    const versions = [...list].sort((a, b) => a.version - b.version);
    const active = versions.find((v) => v.isActive) ?? null;
    const maes = versions.map((v) => v.maeAfter).filter((v): v is number => v != null);
    const latest = versions[versions.length - 1]!;
    out.push({
      lineageKey,
      versions,
      activeMae: active?.maeAfter ?? null,
      activeVersion: active?.version ?? null,
      bestMae: maes.length ? Math.min(...maes) : null,
      latestReadings: latest.readings,
      latestCases: latest.cases,
      promotions: versions.filter((v) => v.promoted).length,
    });
  }
  return out.sort((a, b) => b.latestReadings - a.latestReadings);
}

export interface Hyperparameter {
  name: string;
  value: string;
  /** What the setting does, in one clinical sentence. */
  note: string;
}

/** One fold of the held-out scoring: a single patient kept out of the fit. */
export interface FoldScore {
  caseKey: string;
  label: string;
  n: number;
  mae: number;
}

export interface FoldReport {
  lineageKey: string;
  family: string;
  readings: number;
  folds: FoldScore[];
  /** Error on the data the model was fitted on. */
  inSampleMae: number | null;
  /** Error on patients held out of the fit. */
  outOfSampleMae: number | null;
  /** How much worse the model does on unseen patients, in index points. */
  optimism: number | null;
  median: number | null;
  worst: FoldScore | null;
  best: FoldScore | null;
}

/** Fold scores, hardest patient first, plus the spread across patients. */
export function summariseFolds(
  lineageKey: string,
  family: string,
  readings: number,
  folds: FoldScore[],
  inSampleMae: number | null,
  outOfSampleMae: number | null,
): FoldReport {
  const sorted = [...folds].sort((a, b) => b.mae - a.mae);
  const byScore = [...folds].sort((a, b) => a.mae - b.mae);
  const mid = byScore.length
    ? byScore.length % 2
      ? byScore[(byScore.length - 1) / 2]!.mae
      : (byScore[byScore.length / 2 - 1]!.mae + byScore[byScore.length / 2]!.mae) / 2
    : null;
  return {
    lineageKey,
    family,
    readings,
    folds: sorted,
    inSampleMae,
    outOfSampleMae,
    optimism:
      inSampleMae != null && outOfSampleMae != null
        ? Number((outOfSampleMae - inSampleMae).toFixed(3))
        : null,
    median: mid == null ? null : Number(mid.toFixed(3)),
    worst: sorted[0] ?? null,
    best: byScore[0] ?? null,
  };
}
