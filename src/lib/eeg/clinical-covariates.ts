/**
 * Structured chronic conditions and acute pathology.
 *
 * The free-text "clinical features" chips were good enough for the AI to read,
 * but they are useless as model covariates: nothing constrains what is entered,
 * so the same patient could be filed three different ways and COEBIS would see
 * three unrelated levels. This module defines a closed, validated vocabulary
 * and collapses it into a handful of coarse levels the depth model can actually
 * learn from alongside age and sex.
 *
 * Deliberately coarse: with tens of cases, a per-condition term would be noise.
 * Chronic disease becomes a burden band plus a CNS flag; acute illness becomes
 * a class (systemic / neurological / both).
 */

import { z } from "zod";

export type ConditionSystem =
  | "neuro"
  | "cardioresp"
  | "metabolic"
  | "hepatorenal"
  | "substance";

export interface ConditionOption {
  key: string;
  label: string;
  system: ConditionSystem;
  /** Why this condition changes how the processed EEG should be read. */
  eegRelevance: string;
}

/** Long-standing disease that alters the resting EEG or drug handling. */
export const CHRONIC_CONDITIONS: ConditionOption[] = [
  {
    key: "dementia",
    label: "Dementia / cognitive impairment",
    system: "neuro",
    eegRelevance: "Baseline slowing raises delta power independently of drug effect.",
  },
  {
    key: "prior_stroke",
    label: "Previous stroke",
    system: "neuro",
    eegRelevance: "Focal slowing can make one hemisphere read deeper than the other.",
  },
  {
    key: "epilepsy",
    label: "Known epilepsy",
    system: "neuro",
    eegRelevance: "Epileptiform activity inflates high-frequency and seizure scores.",
  },
  {
    key: "parkinsons",
    label: "Parkinson’s / neurodegenerative",
    system: "neuro",
    eegRelevance: "Altered thalamocortical rhythms shift alpha topography.",
  },
  {
    key: "chronic_alcohol",
    label: "Chronic alcohol excess",
    system: "substance",
    eegRelevance: "Tolerance and withdrawal both raise beta power.",
  },
  {
    key: "opioid_benzo_tolerance",
    label: "Long-term opioid / benzodiazepine use",
    system: "substance",
    eegRelevance: "Beta activation and tolerance raise the apparent index at depth.",
  },
  {
    key: "psychotropics",
    label: "Regular psychotropic medication",
    system: "substance",
    eegRelevance: "Antidepressants and antipsychotics change background rhythms.",
  },
  {
    key: "copd",
    label: "COPD / chronic respiratory disease",
    system: "cardioresp",
    eegRelevance: "Chronic hypercapnia slows the background.",
  },
  {
    key: "heart_failure",
    label: "Heart failure / ischaemic heart disease",
    system: "cardioresp",
    eegRelevance: "Low cardiac output slows drug redistribution.",
  },
  {
    key: "diabetes",
    label: "Diabetes mellitus",
    system: "metabolic",
    eegRelevance: "Microvascular disease is associated with reduced cerebral reserve.",
  },
  {
    key: "obesity",
    label: "Obesity (BMI ≥ 35)",
    system: "metabolic",
    eegRelevance: "Alters pharmacokinetics and increases EMG contamination.",
  },
  {
    key: "ckd",
    label: "Chronic kidney disease",
    system: "hepatorenal",
    eegRelevance: "Uraemia slows the background and delays drug clearance.",
  },
  {
    key: "liver_disease",
    label: "Chronic liver disease",
    system: "hepatorenal",
    eegRelevance: "Encephalopathic slowing mimics deeper anaesthesia.",
  },
  {
    key: "osa",
    label: "Obstructive sleep apnoea",
    system: "cardioresp",
    eegRelevance: "Sleep-fragmented EEG shows more spontaneous slow-wave intrusion.",
  },
];

/** The acute illness or injury the patient is being anaesthetised/sedated for. */
export const ACUTE_PATHOLOGY: ConditionOption[] = [
  {
    key: "sepsis",
    label: "Sepsis",
    system: "metabolic",
    eegRelevance: "Septic encephalopathy slows the background at any drug level.",
  },
  {
    key: "septic_shock",
    label: "Septic shock",
    system: "metabolic",
    eegRelevance: "Hypoperfusion plus vasopressors markedly lower the index.",
  },
  {
    key: "hypoxic_brain_injury",
    label: "Hypoxic brain injury",
    system: "neuro",
    eegRelevance: "Suppression and burst patterns reflect injury, not drug.",
  },
  {
    key: "cardiac_arrest",
    label: "Cardiac arrest (OOHCA / IHCA)",
    system: "neuro",
    eegRelevance: "Post-arrest EEG grading dominates any depth reading.",
  },
  {
    key: "tbi",
    label: "Traumatic brain injury",
    system: "neuro",
    eegRelevance: "Focal injury and oedema distort the index regionally.",
  },
  {
    key: "ich",
    label: "Intracranial haemorrhage",
    system: "neuro",
    eegRelevance: "Regional slowing and asymmetry are expected.",
  },
  {
    key: "acute_stroke",
    label: "Acute ischaemic stroke",
    system: "neuro",
    eegRelevance: "Territorial slowing biases the affected hemisphere.",
  },
  {
    key: "status_epilepticus",
    label: "Status epilepticus",
    system: "neuro",
    eegRelevance: "Ictal activity and treatment-induced suppression coexist.",
  },
  {
    key: "delirium",
    label: "Delirium",
    system: "neuro",
    eegRelevance: "Diffuse slowing before sedation is started.",
  },
  {
    key: "cns_infection",
    label: "CNS infection",
    system: "neuro",
    eegRelevance: "Encephalitic slowing and seizures are common.",
  },
  {
    key: "acute_liver_failure",
    label: "Acute liver failure",
    system: "hepatorenal",
    eegRelevance: "Hepatic encephalopathy produces triphasic slowing.",
  },
  {
    key: "acute_kidney_injury",
    label: "Acute kidney injury",
    system: "hepatorenal",
    eegRelevance: "Uraemic slowing and impaired clearance.",
  },
  {
    key: "respiratory_failure",
    label: "Respiratory failure / ARDS",
    system: "cardioresp",
    eegRelevance: "Hypercapnia and hypoxaemia slow the background.",
  },
  {
    key: "major_haemorrhage",
    label: "Major haemorrhage / shock",
    system: "cardioresp",
    eegRelevance: "Low cerebral perfusion lowers the index at low drug doses.",
  },
  {
    key: "cardiac_surgery",
    label: "Cardiac surgery / bypass",
    system: "cardioresp",
    eegRelevance: "Hypothermia and bypass flow change suppression behaviour.",
  },
  {
    key: "withdrawal",
    label: "Acute alcohol / drug withdrawal",
    system: "substance",
    eegRelevance: "Marked beta activation raises the index.",
  },
];

/** Explicit "nothing of note", so a blank field stays distinguishable. */
export const NONE_KEY = "none";

const chronicKeys = new Set(CHRONIC_CONDITIONS.map((c) => c.key));
const acuteKeys = new Set(ACUTE_PATHOLOGY.map((c) => c.key));

/** How many conditions one case may carry before the entry is unusable. */
export const MAX_SELECTIONS = 8;

function selectionSchema(valid: Set<string>, field: string) {
  return z
    .array(z.string())
    .max(MAX_SELECTIONS, { message: `Select at most ${MAX_SELECTIONS} ${field}.` })
    .superRefine((values, ctx) => {
      const seen = new Set<string>();
      for (const v of values) {
        if (v !== NONE_KEY && !valid.has(v)) {
          ctx.addIssue({ code: "custom", message: `“${v}” is not a recognised ${field} entry.` });
        }
        if (seen.has(v)) {
          ctx.addIssue({ code: "custom", message: `“${v}” is selected twice.` });
        }
        seen.add(v);
      }
      if (values.includes(NONE_KEY) && values.length > 1) {
        ctx.addIssue({
          code: "custom",
          message: `“None” cannot be combined with other ${field} entries.`,
        });
      }
    });
}

export const chronicConditionsSchema = selectionSchema(chronicKeys, "chronic condition");
export const acutePathologySchema = selectionSchema(acuteKeys, "acute pathology");

export const clinicalCovariateSchema = z.object({
  chronicConditions: chronicConditionsSchema,
  acutePathology: acutePathologySchema,
});

export interface ClinicalCovariateInput {
  chronicConditions: string[];
  acutePathology: string[];
}

export interface ValidationResult {
  ok: boolean;
  /** Field-scoped messages, shown next to the chips. */
  errors: { chronicConditions: string[]; acutePathology: string[] };
  /** Selections that survived validation, safe to store and to model on. */
  value: ClinicalCovariateInput;
}

/** Validate and normalise a selection, dropping anything unrecognised. */
export function validateClinicalCovariates(input: ClinicalCovariateInput): ValidationResult {
  const parsed = clinicalCovariateSchema.safeParse(input);
  const errors = { chronicConditions: [] as string[], acutePathology: [] as string[] };
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "chronicConditions") errors.chronicConditions.push(issue.message);
      else if (field === "acutePathology") errors.acutePathology.push(issue.message);
    }
  }
  return {
    ok: parsed.success,
    errors,
    value: {
      chronicConditions: normalise(input.chronicConditions, chronicKeys),
      acutePathology: normalise(input.acutePathology, acuteKeys),
    },
  };
}

function normalise(values: string[] | null | undefined, valid: Set<string>): string[] {
  const list = (values ?? []).filter((v) => v === NONE_KEY || valid.has(v));
  const unique = [...new Set(list)];
  if (unique.includes(NONE_KEY)) return [NONE_KEY];
  return unique.slice(0, MAX_SELECTIONS);
}

/** Toggle one key, keeping “None” mutually exclusive with everything else. */
export function toggleCondition(values: string[], key: string): string[] {
  if (key === NONE_KEY) return values.includes(NONE_KEY) ? [] : [NONE_KEY];
  const without = values.filter((v) => v !== NONE_KEY);
  return without.includes(key) ? without.filter((v) => v !== key) : [...without, key];
}

export function conditionLabel(key: string): string {
  if (key === NONE_KEY) return "None";
  return (
    CHRONIC_CONDITIONS.find((c) => c.key === key)?.label ??
    ACUTE_PATHOLOGY.find((c) => c.key === key)?.label ??
    key
  );
}

/** Coarse levels the depth model is allowed to learn a correction for. */
export interface DerivedClinicalCovariates {
  /** "none" | "single" | "multiple" | "high" — chronic disease burden. */
  chronicBurden: string | null;
  /** "present" | "absent" — chronic neurological/degenerative disease. */
  chronicCns: string | null;
  /** "none" | "systemic" | "neuro" | "mixed" — acute illness class. */
  acuteClass: string | null;
}

export function deriveClinicalCovariates(
  input: Partial<ClinicalCovariateInput> | null | undefined,
): DerivedClinicalCovariates {
  const chronic = normalise(input?.chronicConditions, chronicKeys);
  const acute = normalise(input?.acutePathology, acuteKeys);

  let chronicBurden: string | null = null;
  let chronicCns: string | null = null;
  if (chronic.length) {
    if (chronic[0] === NONE_KEY) {
      chronicBurden = "none";
      chronicCns = "absent";
    } else {
      chronicBurden = chronic.length >= 3 ? "high" : chronic.length === 2 ? "multiple" : "single";
      chronicCns = chronic.some((k) => systemOf(CHRONIC_CONDITIONS, k) === "neuro")
        ? "present"
        : "absent";
    }
  }

  let acuteClass: string | null = null;
  if (acute.length) {
    if (acute[0] === NONE_KEY) {
      acuteClass = "none";
    } else {
      const neuro = acute.some((k) => systemOf(ACUTE_PATHOLOGY, k) === "neuro");
      const systemic = acute.some((k) => systemOf(ACUTE_PATHOLOGY, k) !== "neuro");
      acuteClass = neuro && systemic ? "mixed" : neuro ? "neuro" : "systemic";
    }
  }

  return { chronicBurden, chronicCns, acuteClass };
}

function systemOf(list: ConditionOption[], key: string): ConditionSystem | null {
  return list.find((c) => c.key === key)?.system ?? null;
}

/** True when the case carries acute or chronic neurological disease. */
export function hasNeurologicalInvolvement(
  derived: DerivedClinicalCovariates,
): boolean {
  return derived.chronicCns === "present" || derived.acuteClass === "neuro" || derived.acuteClass === "mixed";
}

/** Plain wording for a derived level, reused in the COEBIS explanation. */
export function clinicalLevelLabel(group: string, level: string): string {
  if (group === "chronic") {
    switch (level) {
      case "none":
        return "no chronic disease";
      case "single":
        return "one chronic condition";
      case "multiple":
        return "two chronic conditions";
      case "high":
        return "three or more chronic conditions";
      default:
        return level;
    }
  }
  if (group === "chronic_cns") {
    return level === "present" ? "chronic neurological disease" : "no chronic neurological disease";
  }
  if (group === "acute") {
    switch (level) {
      case "none":
        return "no acute pathology";
      case "systemic":
        return "acute systemic illness";
      case "neuro":
        return "acute neurological pathology";
      case "mixed":
        return "acute neurological and systemic illness";
      default:
        return level;
    }
  }
  return `${group} ${level}`;
}
