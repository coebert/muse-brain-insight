/**
 * Diagnostic suggestion model built from discovered EEG features.
 *
 * Given the same case-level feature vectors discovery uses (relative band
 * powers, log total power, SEF95, suppression ratio), this fits a Gaussian
 * naive-Bayes classifier for a labelled covariate group — pathology, chronic
 * burden or agent regimen — and scores it honestly with leave-one-case-out
 * cross-validation.
 *
 * Constraints that keep it clinically defensible:
 *  - The unit of independence is the *case*, never the epoch, both for fitting
 *    and for cross-validation.
 *  - Models are fitted per lineage; nothing is pooled across datasets.
 *  - A model below the sufficiency gate is returned with its numbers but
 *    marked insufficient, so the UI can show it as a lead, not a diagnosis.
 *  - Output is a ranked posterior with the features that drove it, so a
 *    clinician can see why — this is decision support, not a verdict.
 */

import {
  DISCOVERY_FEATURES,
  DISCOVERY_GROUPS,
  discoveryLevelLabel,
  type DiscoveryFeatures,
  type DiscoveryRow,
  type FeatureKey,
} from "./covariate-discovery";

/** Classes need this many independent cases before the model is usable. */
export const MIN_CASES_PER_CLASS = 4;
/** At least this many classes must clear the case gate. */
export const MIN_CLASSES = 2;
/** Variance floor so a tight class cannot produce infinite likelihood. */
const VAR_FLOOR = 1e-6;

/** Covariate groups that describe a diagnosis rather than a demographic. */
export const DIAGNOSIS_GROUPS = ["pathology", "chronic", "regimen"] as const;
export type DiagnosisGroup = (typeof DIAGNOSIS_GROUPS)[number];

export interface DiagnosisFeatureStat {
  feature: FeatureKey;
  featureLabel: string;
  mean: number;
  sd: number;
  /** Standardised distance from the pooled mean of the other classes. */
  z: number;
}

export interface DiagnosisClass {
  level: string;
  label: string;
  cases: number;
  prior: number;
  sufficient: boolean;
  stats: DiagnosisFeatureStat[];
  /** One-vs-rest area under the ROC curve from cross-validated posteriors. */
  auc: number | null;
}

export interface DiagnosisPrediction {
  level: string;
  label: string;
  posterior: number;
  /** Log-likelihood ratio against the best competing class. */
  logLR: number;
  drivers: { feature: FeatureKey; featureLabel: string; z: number }[];
}

export interface DiagnosisLineageModel {
  lineage: string;
  group: DiagnosisGroup;
  groupLabel: string;
  cases: number;
  classes: DiagnosisClass[];
  /** Cross-validated accuracy over cases. */
  accuracy: number | null;
  /** Mean per-class recall, so an imbalanced label set is not flattered. */
  balancedAccuracy: number | null;
  sufficiency: "sufficient" | "provisional" | "insufficient";
  blocker: string | null;
  features: FeatureKey[];
}

interface CaseVector {
  caseRef: string;
  level: string;
  x: number[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const variance = (xs: number[], m: number) =>
  xs.length < 2 ? VAR_FLOOR : Math.max(VAR_FLOOR, xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));

function levelFor(group: DiagnosisGroup, cov: DiscoveryRow["covariates"]): string | null {
  const meta = DISCOVERY_GROUPS.find((g) => g.key === group);
  if (!meta) return null;
  for (const key of meta.sourceKeys) {
    const raw = cov[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const level = String(raw).trim();
    if (!level || level.toLowerCase() === "unknown") continue;
    return level;
  }
  return null;
}

/** Reduce epoch rows to one mean feature vector per case. */
export function caseVectors(
  rows: DiscoveryRow[],
  group: DiagnosisGroup,
  features: FeatureKey[],
): CaseVector[] {
  const byCase = new Map<string, { level: string; sums: number[]; counts: number[] }>();
  for (const row of rows) {
    const level = levelFor(group, row.covariates);
    if (!level) continue;
    let entry = byCase.get(row.caseRef);
    if (!entry) {
      entry = { level, sums: features.map(() => 0), counts: features.map(() => 0) };
      byCase.set(row.caseRef, entry);
    }
    features.forEach((f, i) => {
      const v = row.features[f as keyof DiscoveryFeatures];
      if (v == null || !Number.isFinite(v)) return;
      entry!.sums[i]! += v;
      entry!.counts[i]! += 1;
    });
  }
  const out: CaseVector[] = [];
  for (const [caseRef, entry] of byCase) {
    if (entry.counts.some((c) => c === 0)) continue;
    out.push({
      caseRef,
      level: entry.level,
      x: entry.sums.map((s, i) => s / entry.counts[i]!),
    });
  }
  return out.sort((a, b) => a.caseRef.localeCompare(b.caseRef));
}

interface Fitted {
  levels: string[];
  priors: number[];
  means: number[][];
  vars: number[][];
}

function fit(vectors: CaseVector[], dim: number): Fitted | null {
  const byLevel = new Map<string, number[][]>();
  for (const v of vectors) byLevel.set(v.level, [...(byLevel.get(v.level) ?? []), v.x]);
  const levels = [...byLevel.keys()].sort();
  if (levels.length < MIN_CLASSES) return null;
  const priors: number[] = [];
  const means: number[][] = [];
  const vars: number[][] = [];
  for (const level of levels) {
    const xs = byLevel.get(level)!;
    priors.push(xs.length / vectors.length);
    const m: number[] = [];
    const s: number[] = [];
    for (let d = 0; d < dim; d++) {
      const col = xs.map((x) => x[d]!);
      const mu = mean(col);
      m.push(mu);
      s.push(variance(col, mu));
    }
    means.push(m);
    vars.push(s);
  }
  return { levels, priors, means, vars };
}

function posteriors(model: Fitted, x: number[]): number[] {
  const logs = model.levels.map((_, c) => {
    let lp = Math.log(model.priors[c]!);
    for (let d = 0; d < x.length; d++) {
      const mu = model.means[c]![d]!;
      const v = model.vars[c]![d]!;
      lp += -0.5 * Math.log(2 * Math.PI * v) - ((x[d]! - mu) ** 2) / (2 * v);
    }
    return lp;
  });
  const max = Math.max(...logs);
  const exps = logs.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/** Area under the ROC curve for scores against a binary label. */
export function rocAuc(scores: number[], labels: boolean[]): number | null {
  const pos = labels.filter(Boolean).length;
  const neg = labels.length - pos;
  if (!pos || !neg) return null;
  const idx = scores.map((s, i) => ({ s, y: labels[i]! })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.s === idx[i]!.s) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (idx[k]!.y) rankSum += rank;
    i = j + 1;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Fit and cross-validate a diagnosis model for one lineage and label group. */
export function fitDiagnosisModel(
  lineage: string,
  rows: DiscoveryRow[],
  group: DiagnosisGroup,
): DiagnosisLineageModel {
  const featureMetas = DISCOVERY_FEATURES;
  const features = featureMetas.map((f) => f.key);
  const groupLabel = DISCOVERY_GROUPS.find((g) => g.key === group)?.label ?? group;
  const vectors = caseVectors(rows, group, features);

  const base: DiagnosisLineageModel = {
    lineage,
    group,
    groupLabel,
    cases: vectors.length,
    classes: [],
    accuracy: null,
    balancedAccuracy: null,
    sufficiency: "insufficient",
    blocker: null,
    features,
  };

  const fitted = fit(vectors, features.length);
  if (!fitted) {
    return {
      ...base,
      blocker: `Fewer than ${MIN_CLASSES} labelled ${groupLabel.toLowerCase()} classes in this lineage (${vectors.length} labelled cases).`,
    };
  }

  const counts = new Map<string, number>();
  for (const v of vectors) counts.set(v.level, (counts.get(v.level) ?? 0) + 1);

  // Leave-one-case-out cross-validation.
  const cvScores: number[][] = [];
  const cvPredicted: (string | null)[] = [];
  for (let i = 0; i < vectors.length; i++) {
    const train = vectors.filter((_, j) => j !== i);
    const m = fit(train, features.length);
    if (!m) {
      cvScores.push(fitted.levels.map(() => 0));
      cvPredicted.push(null);
      continue;
    }
    const p = posteriors(m, vectors[i]!.x);
    const scores = fitted.levels.map((lv) => {
      const k = m.levels.indexOf(lv);
      return k >= 0 ? p[k]! : 0;
    });
    cvScores.push(scores);
    let best = 0;
    for (let k = 1; k < scores.length; k++) if (scores[k]! > scores[best]!) best = k;
    cvPredicted.push(fitted.levels[best]!);
  }

  const scored = cvPredicted.filter((p) => p != null).length;
  let correct = 0;
  const perClass = new Map<string, { n: number; hit: number }>();
  vectors.forEach((v, i) => {
    const p = cvPredicted[i];
    if (p == null) return;
    const entry = perClass.get(v.level) ?? { n: 0, hit: 0 };
    entry.n += 1;
    if (p === v.level) {
      entry.hit += 1;
      correct += 1;
    }
    perClass.set(v.level, entry);
  });
  const recalls = [...perClass.values()].filter((e) => e.n > 0).map((e) => e.hit / e.n);

  const classes: DiagnosisClass[] = fitted.levels.map((level, c) => {
    const n = counts.get(level) ?? 0;
    const others = vectors.filter((v) => v.level !== level).map((v) => v.x);
    const stats: DiagnosisFeatureStat[] = features.map((f, d) => {
      const meta = featureMetas[d]!;
      const mu = fitted.means[c]![d]!;
      const sd = Math.sqrt(fitted.vars[c]![d]!);
      const otherCol = others.map((x) => x[d]!);
      const om = mean(otherCol);
      const os = Math.sqrt(variance(otherCol, om));
      const pooled = Math.sqrt((sd * sd + os * os) / 2) || VAR_FLOOR;
      return {
        feature: f,
        featureLabel: meta.label,
        mean: Number(mu.toFixed(meta.dp + 1)),
        sd: Number(sd.toFixed(meta.dp + 1)),
        z: Number(((mu - om) / pooled).toFixed(2)),
      };
    });
    stats.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    const auc = scored
      ? rocAuc(
          cvScores.map((s) => s[c]!),
          vectors.map((v) => v.level === level),
        )
      : null;
    return {
      level,
      label: discoveryLevelLabel(group, level),
      cases: n,
      prior: Number((fitted.priors[c] ?? 0).toFixed(2)),
      sufficient: n >= MIN_CASES_PER_CLASS,
      stats,
      auc: auc == null ? null : Number(auc.toFixed(2)),
    };
  });

  const sufficientClasses = classes.filter((c) => c.sufficient).length;
  const sufficiency: DiagnosisLineageModel["sufficiency"] =
    sufficientClasses >= MIN_CLASSES
      ? "sufficient"
      : sufficientClasses >= 1
        ? "provisional"
        : "insufficient";
  const blocker =
    sufficiency === "sufficient"
      ? null
      : `Only ${sufficientClasses} of ${classes.length} classes reach ${MIN_CASES_PER_CLASS} independent cases — treat as a lead, not a diagnosis.`;

  return {
    ...base,
    classes: classes.sort((a, b) => b.cases - a.cases),
    accuracy: scored ? Number((correct / scored).toFixed(2)) : null,
    balancedAccuracy: recalls.length
      ? Number((recalls.reduce((a, b) => a + b, 0) / recalls.length).toFixed(2))
      : null,
    sufficiency,
    blocker,
  };
}

/** Fit every diagnosis group for every lineage present in the rows. */
export function fitDiagnosisModels(rows: DiscoveryRow[]): DiagnosisLineageModel[] {
  const byLineage = new Map<string, DiscoveryRow[]>();
  for (const row of rows) byLineage.set(row.lineage, [...(byLineage.get(row.lineage) ?? []), row]);
  const out: DiagnosisLineageModel[] = [];
  for (const [lineage, ls] of byLineage) {
    for (const group of DIAGNOSIS_GROUPS) {
      const model = fitDiagnosisModel(lineage, ls, group);
      if (model.cases > 0) out.push(model);
    }
  }
  return out.sort((a, b) => b.cases - a.cases || a.lineage.localeCompare(b.lineage));
}

/** Score one live feature vector against a fitted lineage model. */
export function suggestDiagnosis(
  model: DiagnosisLineageModel,
  features: DiscoveryFeatures,
): DiagnosisPrediction[] {
  if (model.classes.length < MIN_CLASSES) return [];
  const x = model.features.map((f) => {
    const v = features[f as keyof DiscoveryFeatures];
    return v != null && Number.isFinite(v) ? (v as number) : null;
  });
  const dims = x.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  if (!dims.length) return [];

  const logs = model.classes.map((cls) => {
    const byFeature = new Map(cls.stats.map((s) => [s.feature, s]));
    let lp = Math.log(Math.max(cls.prior, 1e-6));
    for (const d of dims) {
      const stat = byFeature.get(model.features[d]!);
      if (!stat) continue;
      const v = Math.max(stat.sd * stat.sd, VAR_FLOOR);
      lp += -0.5 * Math.log(2 * Math.PI * v) - ((x[d]! - stat.mean) ** 2) / (2 * v);
    }
    return lp;
  });
  const max = Math.max(...logs);
  const exps = logs.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);

  return model.classes
    .map((cls, i) => {
      const rivals = logs.filter((_, j) => j !== i);
      return {
        level: cls.level,
        label: cls.label,
        posterior: Number((exps[i]! / sum).toFixed(3)),
        logLR: Number((logs[i]! - Math.max(...rivals)).toFixed(2)),
        drivers: cls.stats.slice(0, 3).map((s) => ({
          feature: s.feature,
          featureLabel: s.featureLabel,
          z: s.z,
        })),
      };
    })
    .sort((a, b) => b.posterior - a.posterior);
}
