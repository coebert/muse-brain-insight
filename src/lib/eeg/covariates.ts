/**
 * Patient covariates used to personalise COEBIS.
 *
 * Commercial BIS applies one processing chain to every patient: an 85-year-old
 * frail patient on a volatile agent and a 25-year-old on propofol/remifentanil
 * are read on exactly the same scale, even though their EEG generators differ.
 * This module defines the small, deliberately coarse set of covariates the app
 * records per case and the shape of the residual corrections COEBIS learns for
 * each level of them.
 *
 * Every correction is an *additive adjustment in index points* applied after
 * the affine + knot alignment, shrunk toward zero and capped, so a covariate
 * can nudge the number but never redefine it.
 */

import { clinicalLevelLabel } from "./clinical-covariates";



/** One learned residual correction for a covariate level. */
export interface CovariateTerm {
  /** Covariate family, e.g. "age" | "sex" | "regimen" | "frailty". */
  group: string;
  /** Level within the family, e.g. "75-89". */
  level: string;
  /** Index points added when the case matches this level. */
  dy: number;
  /** Paired readings the term was fitted on. */
  n: number;
}

/** The covariates known for the case currently being displayed. */
export interface CaseCovariates {
  ageBand?: string | null;
  sex?: string | null;
  regimen?: string | null;
  frailty?: string | null;
  /** Chronic disease burden band, derived from the structured selection. */
  chronicBurden?: string | null;
  /** Whether chronic neurological disease is present. */
  chronicCns?: string | null;
  /** Class of the acute pathology being treated. */
  acuteClass?: string | null;
}

export const COVARIATE_GROUPS = [
  "age",
  "sex",
  "regimen",
  "frailty",
  "chronic",
  "chronic_cns",
  "acute",
] as const;
export type CovariateGroup = (typeof COVARIATE_GROUPS)[number];


/** Age bands, matching the banding used when a case is filed. */
export const AGE_BANDS = ["<18", "18-39", "40-59", "60-74", "75-89", "90+"] as const;

export const REGIMENS: { key: string; label: string; short: string }[] = [
  { key: "propofol_tiva", label: "Propofol TIVA (no opioid infusion)", short: "Propofol TIVA" },
  { key: "propofol_opioid", label: "Propofol + opioid TCI", short: "Propofol+opioid" },
  { key: "propofol_ketamine", label: "Propofol + ketamine", short: "Propofol+ketamine" },
  { key: "volatile", label: "Volatile agent", short: "Volatile" },
  { key: "volatile_opioid", label: "Volatile + opioid infusion", short: "Volatile+opioid" },
  { key: "sedation_infusion", label: "ICU sedation infusion", short: "ICU sedation" },
  { key: "other", label: "Other / mixed", short: "Other" },
];

export const FRAILTY_LEVELS: { key: string; label: string }[] = [
  { key: "fit", label: "Fit / independent" },
  { key: "mild", label: "Mildly frail" },
  { key: "moderate", label: "Moderately frail" },
  { key: "severe", label: "Severely frail" },
];

export function regimenLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return REGIMENS.find((r) => r.key === key)?.short ?? key;
}

/** Human wording for a covariate level, for the "why is COEBIS adjusted" line. */
export function covariateLabel(group: string, level: string): string {
  switch (group) {
    case "age":
      return `age ${level}`;
    case "sex":
      return level.toLowerCase();
    case "regimen":
      return (regimenLabel(level) ?? level).toLowerCase();
    case "frailty":
      return `${level} frailty`;
    case "chronic":
    case "chronic_cns":
    case "acute":
      return clinicalLevelLabel(group, level);
    default:
      return `${group} ${level}`;
  }
}


/** The level of each covariate group for a case, skipping unknowns. */
export function covariateLevels(cov: CaseCovariates | null | undefined): [string, string][] {
  if (!cov) return [];
  const out: [string, string][] = [];
  if (cov.ageBand) out.push(["age", cov.ageBand]);
  if (cov.sex) out.push(["sex", cov.sex]);
  if (cov.regimen) out.push(["regimen", cov.regimen]);
  if (cov.frailty) out.push(["frailty", cov.frailty]);
  if (cov.chronicBurden) out.push(["chronic", cov.chronicBurden]);
  if (cov.chronicCns) out.push(["chronic_cns", cov.chronicCns]);
  if (cov.acuteClass) out.push(["acute", cov.acuteClass]);
  return out;
}


/** No single covariate may move the index more than this. */
export const MAX_TERM_ADJUSTMENT = 6;
/** Nor may all of them together. */
export const MAX_TOTAL_ADJUSTMENT = 10;

export interface CovariateAdjustment {
  total: number;
  parts: { group: string; level: string; dy: number; n: number }[];
}

/**
 * Sum the learned corrections that apply to a case. Unknown covariates simply
 * contribute nothing, so a case filed without an age still gets the pooled
 * model rather than no model.
 */
export function covariateAdjustment(
  terms: CovariateTerm[] | undefined,
  cov: CaseCovariates | null | undefined,
): CovariateAdjustment {
  if (!terms || !terms.length) return { total: 0, parts: [] };
  const levels = covariateLevels(cov);
  const parts: CovariateAdjustment["parts"] = [];
  for (const [group, level] of levels) {
    const term = terms.find((t) => t.group === group && t.level === level);
    if (!term || !Number.isFinite(term.dy) || term.dy === 0) continue;
    const dy = Math.max(-MAX_TERM_ADJUSTMENT, Math.min(MAX_TERM_ADJUSTMENT, term.dy));
    parts.push({ group, level, dy: Number(dy.toFixed(2)), n: term.n });
  }
  const raw = parts.reduce((s, p) => s + p.dy, 0);
  const total = Math.max(-MAX_TOTAL_ADJUSTMENT, Math.min(MAX_TOTAL_ADJUSTMENT, raw));
  return { total: Number(total.toFixed(2)), parts };
}

/** "+3.0 for age 75-89, −1.2 for volatile" */
export function describeCovariateAdjustment(adj: CovariateAdjustment): string {
  if (!adj.parts.length) return "No patient-specific adjustment applied.";
  return adj.parts
    .map((p) => `${p.dy > 0 ? "+" : "−"}${Math.abs(p.dy).toFixed(1)} for ${covariateLabel(p.group, p.level)}`)
    .join(", ");
}

/** "Age 75-89: +3.0 index points" — one learned term, in plain words. */
export function describeTerm(term: CovariateTerm): string {
  const sign = term.dy > 0 ? "+" : "−";
  return `${covariateLabel(term.group, term.level)}: ${sign}${Math.abs(term.dy).toFixed(1)} index points`;
}
