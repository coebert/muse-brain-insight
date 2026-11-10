/**
 * One place that states, per task, what kind of evidence actually exists.
 *
 * The app answers several different questions and none of them validates
 * another: agreeing with a BIS monitor is not detecting unresponsiveness, a
 * suppression grade is not a seizure detector, and synthetic regression
 * vignettes are not human validation. Panels read this registry instead of
 * phrasing their own claims, so the wording cannot drift into "outperforms
 * BIS" or "validated" where the evidence does not support it.
 */
import { COEBIS_V2_MODEL } from "./coebis-v2";

export type ValidationTask =
  | "bis-agreement"
  | "responsiveness"
  | "suppression"
  | "seizure"
  | "asymmetry"
  | "disease-pattern";

/**
 * synthetic-regression — shaped synthetic signals; proves code behaviour only.
 * retrospective-agreement — real human recordings, agreement with another
 *   device's output (not with a clinical truth).
 * retrospective-labelled — real human recordings against clinical/state labels.
 * none — no validation of any kind.
 */
export type EvidenceKind =
  | "synthetic-regression"
  | "retrospective-agreement"
  | "retrospective-labelled"
  | "none";

export interface ValidationEntry {
  task: ValidationTask;
  label: string;
  evidence: EvidenceKind;
  /** What was actually measured, in plain words. */
  basis: string;
  /** What this evidence does NOT show. */
  notShown: string;
  /** Prospective clinical validation has been done. Always false today. */
  prospectivelyValidated: false;
}

const m = COEBIS_V2_MODEL.meta;

export const VALIDATION_REGISTRY: Record<ValidationTask, ValidationEntry> = {
  "bis-agreement": {
    task: "bis-agreement",
    label: "Depth index — research BIS agreement",
    evidence: "retrospective-agreement",
    basis: `COEBIS-2 was fitted to agree with a BIS monitor on ${m.cases} retrospective VitalDB surgical cases (${m.rows.toLocaleString()} paired seconds, ${m.lineage}); whole-patient held-out mean absolute gap ${m.heldOutMae.toFixed(2)} points vs ${m.baselineMae.toFixed(2)} for OpenIBIS on the same readings.`,
    notShown:
      "Agreement with BIS is not evidence of measuring depth or consciousness, and is not a claim to outperform BIS. Not validated on Muse 2 or Regul8, or prospectively.",
    prospectivelyValidated: false,
  },
  responsiveness: {
    task: "responsiveness",
    label: "Responsiveness (awake vs unresponsive)",
    evidence: "retrospective-labelled",
    basis:
      "Graded against published responsiveness labels (Cambridge/Chennu, DOSE-I and others) with patient-held-out folds. No candidate has passed the promotion gate; within-collection separation is modest.",
    notShown: "No validated responsiveness detector exists in the app; scores are research read-outs.",
    prospectivelyValidated: false,
  },
  suppression: {
    task: "suppression",
    label: "Burst suppression grade",
    evidence: "retrospective-labelled",
    basis:
      "Suppression detection graded retrospectively on VitalDB and BDSP recordings with calibrated amplitude. Withheld on devices whose amplitude scale is not calibrated.",
    notShown: "Not prospectively validated; not valid on uncalibrated devices.",
    prospectivelyValidated: false,
  },
  seizure: {
    task: "seizure",
    label: "Seizure pattern score",
    evidence: "synthetic-regression",
    basis:
      "Eight shaped synthetic vignettes (3 ictal, 5 non-ictal) run through the live detector as a regression check.",
    notShown:
      "Synthetic traces are not human recordings: they say nothing about clinical sensitivity or specificity in patients.",
    prospectivelyValidated: false,
  },
  asymmetry: {
    task: "asymmetry",
    label: "Experimental EEG asymmetry/change watch",
    evidence: "synthetic-regression",
    basis: "Unit tests on synthetic left/right traces only.",
    notShown: "No imaging validation: it is not a stroke detector.",
    prospectivelyValidated: false,
  },
  "disease-pattern": {
    task: "disease-pattern",
    label: "Disease pattern matching",
    evidence: "none",
    basis:
      "Exploratory pattern matching; only computable from explicitly confirmed diagnoses with provenance.",
    notShown: "No calibrated disease probabilities; not a diagnostic test.",
    prospectivelyValidated: false,
  },
};

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  "synthetic-regression": "Synthetic regression check — not human validation",
  "retrospective-agreement": "Retrospective agreement with another monitor",
  "retrospective-labelled": "Retrospective, labelled human data",
  none: "Not validated",
};

/** True only for evidence that came from real human recordings. */
export function isHumanEvidence(kind: EvidenceKind): boolean {
  return kind === "retrospective-agreement" || kind === "retrospective-labelled";
}
