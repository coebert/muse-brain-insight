/** Case-level metadata captured at the start of monitoring, never identifiable. */
export interface CaseMeta {
  caseCode: string;
  context: string;
  location: string;
  notes: string;
  /** Free-text clinical summary of the case, mined by the AI for patterns. */
  caseSummary: string;
  ageYears: string;
  sex: string;
  admissionDiagnosis: string;
  clinicalFeatures: string[];
  /** Anaesthetic/sedation regimen, used to personalise COEBIS. */
  regimen: string;
  /** Clinical frailty grouping, used to personalise COEBIS. */
  frailty: string;
}

export const EMPTY_CASE_META: CaseMeta = {
  caseCode: "",
  context: "general_anaesthesia",
  location: "",
  notes: "",
  caseSummary: "",
  ageYears: "",
  sex: "",
  admissionDiagnosis: "",
  clinicalFeatures: [],
  regimen: "",
  frailty: "",
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
