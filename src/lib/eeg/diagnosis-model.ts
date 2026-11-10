/** Exploratory, unvalidated EEG pattern matching; not diagnosis or calibrated risk. */
import {
  DISCOVERY_FEATURES,
  DISCOVERY_GROUPS,
  discoveryLevelLabel,
  type DiscoveryFeatures,
  type DiscoveryRow,
  type FeatureKey,
} from "./covariate-discovery";

/** Classes need this many independent cases for exploratory computability only. */
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
  computable: boolean;
  stats: DiagnosisFeatureStat[];
  /** One-vs-rest area under the ROC curve from cross-validated posteriors. */
  auc: number | null;
}

export interface DiagnosisPrediction {
  level: string;
  label: string;
  relativeScore: number;
  calibrated: false;
  evidenceTier: "exploratory";
  validated: false;
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
  computability: "computable" | "not-computable";
  evidenceTier: "exploratory";
  validated: false;
  calibrated: false;
  labelLevel: "event" | "recording" | "patient" | null;
  labelSource: string | null;
  labelProvenance: string[];
  excludedUnknownCases: number;
  excludedConflictingCases: number;
  independence: string;
  notes: string;
  blocker: string | null;
  features: FeatureKey[];
}

interface CaseVector {
  caseRef: string;
  patientRef: string;
  level: string;
  x: number[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const variance = (xs: number[], m: number) =>
  xs.length < 2 ? VAR_FLOOR : Math.max(VAR_FLOOR, xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));

const DISCLAIMER = "Exploratory pattern-matching (unvalidated), not a diagnosis; relative pattern similarity is uncalibrated.";
type LabelLevel = "event" | "recording" | "patient";
const known = (v: unknown): string | null => {
  if (v == null) return null;
  const text = String(v).trim();
  return !text || /^(unknown|unlabelled|unlabeled|unspecified|n\/a|na|null|none|missing)$/i.test(text) ? null : text;
};

/** Explicit opt-in contract: collection categories and unconfirmed labels are never targets.
 * The source key and independent provenance must accompany each confirmed label.
 */
function labelFor(group: DiagnosisGroup, cov: DiscoveryRow["covariates"]) {
  if (group !== "pathology") return null;
  const value = known(cov["confirmed_diagnosis"]);
  const provenance = known(cov["confirmed_diagnosis_provenance"]);
  const level = cov["confirmed_diagnosis_level"];
  if (!value || !provenance || !["event", "recording", "patient"].includes(String(level))) return null;
  return { value, provenance, labelLevel: level as LabelLevel, labelSource: "confirmed_diagnosis" };
}

function aggregate(rows: DiscoveryRow[], group: DiagnosisGroup, features: FeatureKey[]) {
  const byCase = new Map<string, DiscoveryRow[]>();
  for (const row of rows) byCase.set(row.caseRef, [...(byCase.get(row.caseRef) ?? []), row]);
  const vectors: CaseVector[] = [];
  let excludedUnknownCases = 0;
  let excludedConflictingCases = 0;
  const labels: NonNullable<ReturnType<typeof labelFor>>[] = [];
  for (const [caseRef, rs] of byCase) {
    const resolved = rs.map(r => labelFor(group, r.covariates));
    if (resolved.some(l => !l)) { excludedUnknownCases++; continue; }
    const ls = resolved as NonNullable<ReturnType<typeof labelFor>>[];
    const first = ls[0]!;
    const patients = new Set(rs.map(r => known(r.covariates["patient_id"]) ?? known(r.covariates["patientRef"])).filter(Boolean));
    // Never collapse distinct event labels, levels, or patients into a case class.
    if (patients.size > 1 || ls.some(l => l.value !== first.value || l.labelLevel !== first.labelLevel)) {
      excludedConflictingCases++; continue;
    }
    const x = features.map(f => {
      const values = rs.map(r => r.features[f]).filter((v): v is number => v != null && Number.isFinite(v));
      return values.length ? mean(values) : NaN;
    });
    if (x.some(v => !Number.isFinite(v))) continue;
    labels.push(...ls);
    vectors.push({ caseRef, patientRef: patients.size ? `patient:${[...patients][0]}` : `case:${caseRef}`, level: first.value, x });
  }
  return { vectors: vectors.sort((a,b) => a.caseRef.localeCompare(b.caseRef)), labels, excludedUnknownCases, excludedConflictingCases };
}

/** Epochs aggregate to cases; conflicting event labels are excluded, not promoted. */
export function caseVectors(rows: DiscoveryRow[], group: DiagnosisGroup, features: FeatureKey[]): CaseVector[] {
  return aggregate(rows, group, features).vectors;
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
  const scopedRows = rows.filter(r => r.lineage === lineage);
  const aggregated = aggregate(scopedRows, group, features);
  const { vectors, labels, excludedUnknownCases, excludedConflictingCases } = aggregated;
  const levels = new Set(labels.map(l => l.labelLevel));

  const base: DiagnosisLineageModel = {
    lineage,
    group,
    groupLabel,
    cases: vectors.length,
    classes: [],
    accuracy: null,
    balancedAccuracy: null,
    computability: "not-computable",
    evidenceTier: "exploratory",
    validated: false,
    calibrated: false,
    labelLevel: levels.size === 1 ? labels[0]!.labelLevel : null,
    labelSource: labels.length ? "confirmed_diagnosis" : null,
    labelProvenance: [...new Set(labels.map(l => l.provenance))],
    excludedUnknownCases,
    excludedConflictingCases,
    independence: scopedRows.some(r => known(r.covariates["patient_id"]) || known(r.covariates["patientRef"]))
      ? "Leave-one-patient-out where identity is available; caseRef is a patient proxy otherwise."
      : "Leave-one-case-out; caseRef is a patient proxy, patient independence is unverified.",
    notes: DISCLAIMER,
    blocker: null,
    features,
  };

  if (group !== "pathology") return { ...base, blocker: `${DISCLAIMER} Disallowed disease target: ${group} describes burden or regimen, not a confirmed diagnosis.` };
  if (!labels.length) return { ...base, blocker: `${DISCLAIMER} No confirmed per-recording/patient/event diagnosis with provenance. pathology_category is a dataset/collection descriptor, not a disease target.` };
  if (levels.size !== 1) return { ...base, blocker: `${DISCLAIMER} Mixed event, recording and patient label levels cannot be pooled.` };
  const fitted = fit(vectors, features.length);
  if (!fitted) {
    return {
      ...base,
      blocker: `${DISCLAIMER} Fewer than ${MIN_CLASSES} labelled ${groupLabel.toLowerCase()} classes in this lineage (${vectors.length} labelled cases).`,
    };
  }

  const counts = new Map<string, number>();
  for (const v of vectors) counts.set(v.level, (counts.get(v.level) ?? 0) + 1);

  // Leave-one-case-out cross-validation.
  const cvScores: number[][] = [];
  const cvPredicted: (string | null)[] = [];
  for (let i = 0; i < vectors.length; i++) {
    const train = vectors.filter(v => v.patientRef !== vectors[i]!.patientRef);
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
      computable: n >= MIN_CASES_PER_CLASS,
      stats,
      auc: auc == null ? null : Number(auc.toFixed(2)),
    };
  });

  const computableClasses = classes.filter(c => c.computable).length;
  const computability = computableClasses >= MIN_CLASSES ? "computable" : "not-computable";
  const blocker = computability === "computable" ? null
    : `${DISCLAIMER} Only ${computableClasses} classes reach ${MIN_CASES_PER_CLASS} cases; ${MIN_CLASSES} required for exploratory computability.`;

  return {
    ...base,
    classes: classes.sort((a, b) => b.cases - a.cases),
    accuracy: scored ? Number((correct / scored).toFixed(2)) : null,
    balancedAccuracy: recalls.length
      ? Number((recalls.reduce((a, b) => a + b, 0) / recalls.length).toFixed(2))
      : null,
    computability,
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
      out.push(model);
    }
  }
  return out.sort((a, b) => b.cases - a.cases || a.lineage.localeCompare(b.lineage));
}

export interface DiagnosisSuggestionResult {
  eligible: boolean;
  reason: string;
  evidenceTier: "exploratory";
  validated: false;
  calibrated: false;
  predictions: DiagnosisPrediction[];
}

/** Score one live feature vector against a fitted lineage model. */
export function suggestDiagnosis(
  model: DiagnosisLineageModel,
  features: DiscoveryFeatures,
  inputLineage?: string,
): DiagnosisSuggestionResult {
  const reject = (reason: string): DiagnosisSuggestionResult => ({ eligible: false, reason: `${DISCLAIMER} ${reason}`, evidenceTier: "exploratory", validated: false, calibrated: false, predictions: [] });
  if (model.group !== "pathology" || model.labelSource !== "confirmed_diagnosis" || !model.labelLevel || !model.labelProvenance.length)
    return reject("Disallowed target or missing confirmed-diagnosis provenance.");
  if (model.computability !== "computable" || model.classes.filter(c => c.computable && c.cases >= MIN_CASES_PER_CLASS).length < MIN_CLASSES)
    return reject(`At least ${MIN_CLASSES} classes with ${MIN_CASES_PER_CLASS} cases are required.`);
  if (inputLineage !== undefined && inputLineage !== model.lineage) return reject("Input lineage differs from model lineage.");
  const missing = model.features.filter(f => features[f] == null || !Number.isFinite(features[f]));
  if (!model.features.length || missing.length) return reject(`Missing finite model features: ${missing.join(", ") || "empty feature set"}.`);
  const x = model.features.map(f => features[f]!);
  const dims = x.map((_, i) => i);

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

  const predictions: DiagnosisPrediction[] = model.classes
    .map((cls, i) => {
      const rivals = logs.filter((_, j) => j !== i);
      return {
        level: cls.level,
        label: cls.label,
        calibrated: false as const,
        evidenceTier: "exploratory" as const,
        validated: false as const,
        relativeScore: Number((exps[i]! / sum).toFixed(3)),
        logLR: Number((logs[i]! - Math.max(...rivals)).toFixed(2)),
        drivers: cls.stats.slice(0, 3).map((s) => ({
          feature: s.feature,
          featureLabel: s.featureLabel,
          z: s.z,
        })),
      };
    })
    .sort((a, b) => b.relativeScore - a.relativeScore);
  return { eligible: true, reason: DISCLAIMER, evidenceTier: "exploratory", validated: false, calibrated: false, predictions };
}
