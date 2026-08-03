/** Case-level metadata captured at the start of monitoring, never identifiable. */
export interface CaseMeta {
  caseCode: string;
  context: string;
  location: string;
  notes: string;
  ageYears: string;
  sex: string;
  admissionDiagnosis: string;
  clinicalFeatures: string[];
}

export const EMPTY_CASE_META: CaseMeta = {
  caseCode: "",
  context: "general_anaesthesia",
  location: "",
  notes: "",
  ageYears: "",
  sex: "",
  admissionDiagnosis: "",
  clinicalFeatures: [],
};

export const CONTEXTS = [
  { value: "general_anaesthesia", label: "General anaesthesia" },
  { value: "icu_sedation", label: "ICU sedation" },
  { value: "procedural_sedation", label: "Procedural sedation" },
  { value: "other", label: "Other" },
];

export const SEX_OPTIONS = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Not recorded" },
];

export const CLINICAL_FEATURES = [
  "Sepsis",
  "Septic shock",
  "Delirium",
  "OOHCA",
  "IHCA",
  "Hypoxic brain injury",
  "Dementia",
  "Traumatic brain injury",
  "Intracranial haemorrhage",
  "Stroke",
  "Known epilepsy",
  "Status epilepticus",
  "Liver failure",
  "Renal failure",
  "Alcohol / drug withdrawal",
  "Post-cardiac surgery",
  "Neuromuscular blockade",
  "Therapeutic hypothermia",
];