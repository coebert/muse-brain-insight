/**
 * Covariate–feature discovery.
 *
 * Every lineage the app has ingested carries spectral epochs plus whatever
 * patient description came with them: age band, sex, regimen/agent, pathology.
 * This module looks for reproducible associations between those covariates and
 * the EEG features COEBIS is built from (band powers, spectral edge,
 * suppression), so the depth model can carry explicit covariate terms instead
 * of averaging every patient onto one scale.
 *
 * Two deliberate constraints:
 *  - Statistics are computed on *case-level* means, never per epoch. A single
 *    long recording contributes thousands of epochs; treating them as
 *    independent would make every association look overwhelmingly significant.
 *  - Nothing here modifies COEBIS. It emits *candidate* covariate terms with a
 *    shrunken index-point offset, which still have to clear the normal fitting
 *    gates on paired reference data before they can be promoted.
 */

import { benjaminiHochberg } from "./fdr";
import { AGE_BANDS, regimenLabel } from "./covariates";

/* ------------------------------------------------------------------ inputs */

export interface DiscoveryFeatures {
  /** Fraction of total power in each band (0-1). */
  relDelta: number;
  relTheta: number;
  relAlpha: number;
  relBeta: number;
  relGamma: number;
  /** Natural log of total band power, so scale differences are additive. */
  logTotalPower: number;
  sef95: number | null;
  /** Suppression ratio as a fraction (0-1). */
  suppressionRatio: number | null;
}

export interface DiscoveryRow {
  lineage: string;
  /** Case / recording identifier — the unit of statistical independence. */
  caseRef: string;
  covariates: Record<string, string | number | null | undefined>;
  features: DiscoveryFeatures;
}

/* ----------------------------------------------------------------- feature */

export type FeatureKey = keyof DiscoveryFeatures;

export interface FeatureMeta {
  key: FeatureKey;
  label: string;
  unit: string;
  /** Decimal places for display. */
  dp: number;
  /**
   * Heuristic sensitivity of a BIS-scale index to this feature, in index
   * points per unit. Used only to translate a discovered feature shift into a
   * candidate COEBIS offset; the fitted value always overrides it.
   */
  indexPointsPerUnit: number;
}

export const DISCOVERY_FEATURES: FeatureMeta[] = [
  { key: "relDelta", label: "Relative delta", unit: "fraction", dp: 3, indexPointsPerUnit: -12 },
  { key: "relTheta", label: "Relative theta", unit: "fraction", dp: 3, indexPointsPerUnit: -4 },
  { key: "relAlpha", label: "Relative alpha", unit: "fraction", dp: 3, indexPointsPerUnit: -5 },
  { key: "relBeta", label: "Relative beta", unit: "fraction", dp: 3, indexPointsPerUnit: 25 },
  { key: "relGamma", label: "Relative gamma", unit: "fraction", dp: 3, indexPointsPerUnit: 8 },
  { key: "logTotalPower", label: "Log total power", unit: "ln µV²", dp: 2, indexPointsPerUnit: -1.5 },
  { key: "sef95", label: "SEF95", unit: "Hz", dp: 2, indexPointsPerUnit: 2 },
  {
    key: "suppressionRatio",
    label: "Suppression ratio",
    unit: "fraction",
    dp: 3,
    indexPointsPerUnit: -40,
  },
];

/* --------------------------------------------------------------- covariates */

export interface CovariateGroupMeta {
  key: string;
  label: string;
  kind: "ordinal" | "categorical";
  /** Source keys in the stored covariate JSON, in priority order. */
  sourceKeys: string[];
  /** Ordering for ordinal string levels. */
  order?: readonly string[];
}

export const DISCOVERY_GROUPS: CovariateGroupMeta[] = [
  {
    key: "age",
    label: "Age band",
    kind: "ordinal",
    sourceKeys: ["age_band", "ageBand", "age"],
    order: AGE_BANDS,
  },
  { key: "sex", label: "Sex", kind: "categorical", sourceKeys: ["sex", "gender"] },
  {
    key: "regimen",
    label: "Agent / regimen",
    kind: "categorical",
    sourceKeys: ["regimen", "agent", "drug", "anaesthetic"],
  },
  {
    key: "agent_dose",
    label: "Propofol dose band",
    kind: "ordinal",
    sourceKeys: ["propofol_max_mg", "propofol_mg", "agent_dose"],
  },
  {
    key: "setting",
    label: "Care setting",
    kind: "categorical",
    sourceKeys: ["setting", "procedure", "task"],
  },
  {
    key: "pathology",
    label: "Pathology",
    kind: "categorical",
    sourceKeys: ["pathology_category", "acute_class", "acute_pathology"],
  },
  {
    key: "chronic",
    label: "Chronic burden",
    kind: "ordinal",
    sourceKeys: ["chronic_burden", "chronicBurden"],
    order: ["none", "low", "moderate", "high"],
  },
  {
    key: "depth_label",
    label: "Sedation depth label",
    kind: "ordinal",
    sourceKeys: ["moaas_min", "moaas", "depth_label"],
  },
];

/** Human wording for a discovered level. */
export function discoveryLevelLabel(group: string, level: string): string {
  if (group === "regimen") return regimenLabel(level) ?? level;
  if (group === "sex") return level.toUpperCase() === "M" ? "Male" : level.toUpperCase() === "F" ? "Female" : level;
  return level.replace(/_/g, " ");
}

function levelOf(
  meta: CovariateGroupMeta,
  cov: DiscoveryRow["covariates"],
): { level: string; rank: number | null } | null {
  for (const key of meta.sourceKeys) {
    const raw = cov[key];
    if (raw === null || raw === undefined || raw === "") continue;
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) continue;
      return { level: String(raw), rank: raw };
    }
    const level = String(raw).trim();
    if (!level || level.toLowerCase() === "unknown") continue;
    if (meta.kind === "ordinal") {
      if (meta.order) {
        const idx = meta.order.indexOf(level);
        if (idx >= 0) return { level, rank: idx };
      }
      const num = Number(level.replace(/[^0-9.-]/g, ""));
      return { level, rank: Number.isFinite(num) ? num : null };
    }
    return { level, rank: null };
  }
  return null;
}

/* ------------------------------------------------------------------- stats */

/** Regularized incomplete beta, used for t and F tail probabilities. */
function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  let qab = a + b,
    qap = a + 1,
    qam = a - 1,
    c = 1,
    d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

function lnGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i]! / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for Student's t with `df` degrees of freedom. */
export function tTestP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** Upper-tail p-value for an F statistic. */
export function fTestP(f: number, df1: number, df2: number): number {
  if (!Number.isFinite(f) || f <= 0 || df1 <= 0 || df2 <= 0) return 1;
  return betai(df2 / 2, df1 / 2, df2 / (df2 + df1 * f));
}

function ranks(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]!.i] = rank;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation. */
export function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/* ----------------------------------------------------------------- results */

export interface DiscoveryLevel {
  level: string;
  label: string;
  cases: number;
  epochs: number;
  mean: number;
  sd: number;
  /** Difference from the lineage grand mean, in feature units. */
  delta: number;
  /** Difference expressed in pooled standard deviations. */
  effect: number;
}

export interface DiscoveryAssociation {
  lineage: string;
  group: string;
  groupLabel: string;
  kind: "ordinal" | "categorical";
  feature: FeatureKey;
  featureLabel: string;
  featureUnit: string;
  featureDp: number;
  cases: number;
  epochs: number;
  /** Spearman rho for ordinal covariates, otherwise null. */
  rho: number | null;
  /** Share of between-case variance explained by the covariate. */
  etaSquared: number;
  p: number;
  q: number;
  significant: boolean;
  sufficiency: "sufficient" | "provisional" | "insufficient";
  levels: DiscoveryLevel[];
}

export interface CandidateTermContribution {
  feature: FeatureKey;
  featureLabel: string;
  delta: number;
  indexPoints: number;
}

export interface CandidateCoebisTerm {
  lineage: string;
  group: string;
  groupLabel: string;
  level: string;
  levelLabel: string;
  cases: number;
  epochs: number;
  /** Shrunken candidate offset in index points. */
  dy: number;
  /** Offset before shrinkage and capping. */
  rawDy: number;
  shrinkage: number;
  contributions: CandidateTermContribution[];
  status: "candidate" | "watch";
  rationale: string;
}

export interface LineageDiscovery {
  lineage: string;
  cases: number;
  epochs: number;
  groupsAvailable: string[];
  associations: DiscoveryAssociation[];
  candidates: CandidateCoebisTerm[];
}

export interface DiscoveryResult {
  lineages: LineageDiscovery[];
  totalEpochs: number;
  generatedAt: string;
}

/** Minimum independent cases per level before a level is reported at all. */
export const MIN_LEVEL_CASES = 2;
/** Cases per level for a level to count as sufficient rather than provisional. */
export const SUFFICIENT_LEVEL_CASES = 5;
/** Shrinkage constant, in cases, applied to candidate index-point offsets. */
export const TERM_SHRINK_CASES = 6;
/** Hard cap on a candidate covariate offset. */
export const MAX_CANDIDATE_DY = 6;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};

interface CaseAggregate {
  caseRef: string;
  epochs: number;
  features: Record<FeatureKey, { sum: number; n: number }>;
  levels: Map<string, { level: string; rank: number | null }>;
}

function aggregateCases(rows: DiscoveryRow[]): CaseAggregate[] {
  const byCase = new Map<string, CaseAggregate>();
  for (const row of rows) {
    let agg = byCase.get(row.caseRef);
    if (!agg) {
      const features = {} as CaseAggregate["features"];
      for (const f of DISCOVERY_FEATURES) features[f.key] = { sum: 0, n: 0 };
      agg = { caseRef: row.caseRef, epochs: 0, features, levels: new Map() };
      byCase.set(row.caseRef, agg);
    }
    agg.epochs += 1;
    for (const f of DISCOVERY_FEATURES) {
      const v = row.features[f.key];
      if (v == null || !Number.isFinite(v)) continue;
      agg.features[f.key].sum += v;
      agg.features[f.key].n += 1;
    }
    for (const g of DISCOVERY_GROUPS) {
      if (agg.levels.has(g.key)) continue;
      const lv = levelOf(g, row.covariates);
      if (lv) agg.levels.set(g.key, lv);
    }
  }
  return [...byCase.values()];
}

function analyseLineage(lineage: string, rows: DiscoveryRow[]): LineageDiscovery {
  const cases = aggregateCases(rows);
  const epochs = rows.length;
  const raw: { assoc: DiscoveryAssociation; p: number }[] = [];
  const groupsAvailable = new Set<string>();

  for (const g of DISCOVERY_GROUPS) {
    const present = cases.filter((c) => c.levels.has(g.key));
    if (present.length) groupsAvailable.add(g.key);
    // Group levels, dropping levels seen in too few independent cases.
    const byLevel = new Map<string, CaseAggregate[]>();
    for (const c of present) {
      const lv = c.levels.get(g.key)!.level;
      byLevel.set(lv, [...(byLevel.get(lv) ?? []), c]);
    }
    const usable = [...byLevel.entries()].filter(([, cs]) => cs.length >= MIN_LEVEL_CASES);
    if (usable.length < 2) continue;

    for (const f of DISCOVERY_FEATURES) {
      const caseValue = (c: CaseAggregate) =>
        c.features[f.key].n ? c.features[f.key].sum / c.features[f.key].n : null;

      const levelStats: DiscoveryLevel[] = [];
      const all: number[] = [];
      const groupsForAnova: number[][] = [];
      for (const [level, cs] of usable) {
        const vals = cs.map(caseValue).filter((v): v is number => v != null);
        if (vals.length < MIN_LEVEL_CASES) continue;
        all.push(...vals);
        groupsForAnova.push(vals);
        levelStats.push({
          level,
          label: discoveryLevelLabel(g.key, level),
          cases: vals.length,
          epochs: cs.reduce((s, c) => s + c.epochs, 0),
          mean: mean(vals),
          sd: sd(vals),
          delta: 0,
          effect: 0,
        });
      }
      if (levelStats.length < 2 || all.length < 4) continue;

      const grand = mean(all);
      const pooled = sd(all) || 1e-9;
      for (const l of levelStats) {
        l.delta = l.mean - grand;
        l.effect = l.delta / pooled;
      }

      // One-way ANOVA on case-level means.
      const nTotal = all.length;
      const k = groupsForAnova.length;
      let ssBetween = 0;
      let ssWithin = 0;
      for (const vals of groupsForAnova) {
        const m = mean(vals);
        ssBetween += vals.length * (m - grand) ** 2;
        for (const v of vals) ssWithin += (v - m) ** 2;
      }
      const ssTotal = ssBetween + ssWithin;
      const etaSquared = ssTotal > 0 ? ssBetween / ssTotal : 0;
      const df1 = k - 1;
      const df2 = nTotal - k;
      const fStat = df2 > 0 && ssWithin > 0 ? ssBetween / df1 / (ssWithin / df2) : 0;
      let p = fTestP(fStat, df1, df2);

      let rho: number | null = null;
      if (g.kind === "ordinal") {
        const pairs: [number, number][] = [];
        for (const [level, cs] of usable) {
          const rank = cs[0]!.levels.get(g.key)!.rank;
          if (rank == null) continue;
          for (const c of cs) {
            const v = caseValue(c);
            if (v != null) pairs.push([rank, v]);
          }
          void level;
        }
        if (pairs.length >= 4) {
          rho = spearman(
            pairs.map((x) => x[0]),
            pairs.map((x) => x[1]),
          );
          const n = pairs.length;
          const t = rho * Math.sqrt((n - 2) / Math.max(1e-9, 1 - rho * rho));
          // Trend test is the more powerful hypothesis for an ordered covariate.
          p = Math.min(p, tTestP(t, n - 2));
        }
      }

      const minCases = Math.min(...levelStats.map((l) => l.cases));
      const sufficiency: DiscoveryAssociation["sufficiency"] =
        minCases >= SUFFICIENT_LEVEL_CASES
          ? "sufficient"
          : minCases >= MIN_LEVEL_CASES
            ? "provisional"
            : "insufficient";

      raw.push({
        p,
        assoc: {
          lineage,
          group: g.key,
          groupLabel: g.label,
          kind: g.kind,
          feature: f.key,
          featureLabel: f.label,
          featureUnit: f.unit,
          featureDp: f.dp,
          cases: nTotal,
          epochs: levelStats.reduce((s, l) => s + l.epochs, 0),
          rho: rho == null ? null : Number(rho.toFixed(3)),
          etaSquared: Number(etaSquared.toFixed(3)),
          p,
          q: 1,
          significant: false,
          sufficiency,
          levels: levelStats.sort((a, b) => b.effect - a.effect),
        },
      });
    }
  }

  // One multiplicity correction per lineage: every covariate × feature cell
  // tested here is part of the same fishing expedition.
  const corrected = benjaminiHochberg(
    raw.map((r) => ({ item: r.assoc, p: r.p })),
    0.05,
  );
  const associations = corrected.map((c) => ({
    ...c.item,
    p: Number(c.p.toFixed(5)),
    q: Number(c.q.toFixed(5)),
    significant: c.significant && c.item.sufficiency !== "insufficient",
  }));
  associations.sort((a, b) => a.q - b.q || Math.abs(b.etaSquared) - Math.abs(a.etaSquared));

  return {
    lineage,
    cases: cases.length,
    epochs,
    groupsAvailable: [...groupsAvailable],
    associations,
    candidates: buildCandidateTerms(lineage, associations),
  };
}

/**
 * Translate significant feature shifts into candidate COEBIS covariate offsets.
 *
 * The offset is the sum of each feature's shift multiplied by a fixed
 * index-point sensitivity, shrunk toward zero by the number of independent
 * cases and capped. It is a starting value for the fitter and a flag for where
 * to look, never a promoted term.
 */
export function buildCandidateTerms(
  lineage: string,
  associations: DiscoveryAssociation[],
): CandidateCoebisTerm[] {
  const byLevel = new Map<string, CandidateCoebisTerm>();
  for (const a of associations) {
    if (a.sufficiency === "insufficient") continue;
    if (!a.significant && a.q > 0.2) continue;
    const meta = DISCOVERY_FEATURES.find((f) => f.key === a.feature)!;
    for (const l of a.levels) {
      const key = `${a.group}:${l.level}`;
      const entry =
        byLevel.get(key) ??
        ({
          lineage,
          group: a.group,
          groupLabel: a.groupLabel,
          level: l.level,
          levelLabel: l.label,
          cases: l.cases,
          epochs: l.epochs,
          dy: 0,
          rawDy: 0,
          shrinkage: 0,
          contributions: [],
          status: "watch",
          rationale: "",
        } satisfies CandidateCoebisTerm);
      const indexPoints = meta.indexPointsPerUnit * l.delta;
      if (!Number.isFinite(indexPoints)) continue;
      entry.contributions.push({
        feature: a.feature,
        featureLabel: a.featureLabel,
        delta: Number(l.delta.toFixed(meta.dp + 1)),
        indexPoints: Number(indexPoints.toFixed(2)),
      });
      entry.rawDy += indexPoints;
      entry.cases = Math.max(entry.cases, l.cases);
      entry.epochs = Math.max(entry.epochs, l.epochs);
      byLevel.set(key, entry);
    }
  }

  const out: CandidateCoebisTerm[] = [];
  for (const entry of byLevel.values()) {
    const lambda = entry.cases / (entry.cases + TERM_SHRINK_CASES);
    const dy = Math.max(
      -MAX_CANDIDATE_DY,
      Math.min(MAX_CANDIDATE_DY, lambda * entry.rawDy),
    );
    if (Math.abs(dy) < 0.2) continue;
    entry.shrinkage = Number(lambda.toFixed(2));
    entry.rawDy = Number(entry.rawDy.toFixed(2));
    entry.dy = Number(dy.toFixed(2));
    entry.contributions.sort((a, b) => Math.abs(b.indexPoints) - Math.abs(a.indexPoints));
    entry.status = entry.cases >= SUFFICIENT_LEVEL_CASES ? "candidate" : "watch";
    const lead = entry.contributions[0];
    entry.rationale = lead
      ? `${lead.featureLabel} ${lead.delta > 0 ? "higher" : "lower"} than the lineage mean in ${entry.levelLabel} cases`
      : "";
    out.push(entry);
  }
  return out.sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy));
}

/** Full discovery pass over every supplied epoch row. */
export function discoverCovariateFeatures(rows: DiscoveryRow[]): DiscoveryResult {
  const byLineage = new Map<string, DiscoveryRow[]>();
  for (const row of rows) {
    byLineage.set(row.lineage, [...(byLineage.get(row.lineage) ?? []), row]);
  }
  const lineages = [...byLineage.entries()]
    .map(([lineage, ls]) => analyseLineage(lineage, ls))
    .sort((a, b) => b.epochs - a.epochs);
  return {
    lineages,
    totalEpochs: rows.length,
    generatedAt: new Date().toISOString(),
  };
}

/** Build the feature vector for one stored epoch. */
export function featuresFromBands(
  bands: Record<string, unknown> | null | undefined,
  totalPower: number | null | undefined,
  sef95: number | null | undefined,
  suppressionRatio: number | null | undefined,
): DiscoveryFeatures | null {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const delta = num(bands?.["delta"]);
  const theta = num(bands?.["theta"]);
  const alpha = num(bands?.["alpha"]);
  const beta = num(bands?.["beta"]);
  const gamma = num(bands?.["gamma"]);
  const sum = delta + theta + alpha + beta + gamma;
  if (!(sum > 0)) return null;
  const total = totalPower && Number.isFinite(totalPower) && totalPower > 0 ? totalPower : sum;
  const sr =
    suppressionRatio == null || !Number.isFinite(suppressionRatio)
      ? null
      : suppressionRatio > 1
        ? suppressionRatio / 100
        : suppressionRatio;
  return {
    relDelta: delta / sum,
    relTheta: theta / sum,
    relAlpha: alpha / sum,
    relBeta: beta / sum,
    relGamma: gamma / sum,
    logTotalPower: Math.log(total),
    sef95: sef95 != null && Number.isFinite(sef95) ? sef95 : null,
    suppressionRatio: sr,
  };
}
