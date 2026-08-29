/**
 * Phase 5 — age- and patient-adjusted depth targets.
 *
 * Commercial BIS prints one target band (40–60) for every patient. The
 * evidence base does not support that: older and frail patients reach the same
 * processed-EEG number at lower drug exposure, spend longer in suppression,
 * and the trials that reduced excessive depth (ENGAGES, BALANCED, and the
 * suppression-avoidance literature) argue for a higher floor rather than a
 * tighter band. ICU sedation is a different question again — the target is
 * usually light sedation, not surgical anaesthesia.
 *
 * This module turns the covariates already recorded per case into a suggested
 * alert window plus the reasoning behind it. It is advisory: the clinician
 * applies it with one tap, or ignores it.
 */

import { regimenLabel } from "./covariates";
import {
  clinicalLevelLabel,
  deriveClinicalCovariates,
} from "./clinical-covariates";

export interface DepthTargetInputs {
  /** Patient age in years, when known. */
  ageYears?: number | null;
  /** Coarse age band, used when an exact age was not entered. */
  ageBand?: string | null;
  frailty?: string | null;
  regimen?: string | null;
  /** Case context, e.g. "general_anaesthesia" | "icu_sedation". */
  context?: string | null;
  /** Structured chronic conditions (keys from CHRONIC_CONDITIONS). */
  chronicConditions?: string[] | null;
  /** Structured acute pathology (keys from ACUTE_PATHOLOGY). */
  acutePathology?: string[] | null;
}

export interface DepthTargetRecommendation {
  low: number;
  high: number;
  /** Short label for the target, e.g. "General anaesthesia, older patient". */
  label: string;
  /** Plain-language reasons, in the order they were applied. */
  reasons: string[];
  /** Cautions that change how the number should be read, not the window. */
  caveats: string[];
  /** True when nothing patient-specific was known and the default was used. */
  isDefault: boolean;
}

const GA_DEFAULT = { low: 40, high: 60 };
const ICU_DEFAULT = { low: 60, high: 80 };

function isIcu(context: string | null | undefined): boolean {
  return (context ?? "").toLowerCase().includes("icu") || (context ?? "").toLowerCase().includes("sedation");
}

/** Approximate mid-point age implied by a band, for the older-patient rules. */
export function bandMidAge(band: string | null | undefined): number | null {
  switch (band) {
    case "<18":
      return 12;
    case "18-39":
      return 29;
    case "40-59":
      return 50;
    case "60-74":
      return 67;
    case "75-89":
      return 82;
    case "90+":
      return 92;
    default:
      return null;
  }
}

function effectiveAge(input: DepthTargetInputs): number | null {
  if (typeof input.ageYears === "number" && Number.isFinite(input.ageYears)) return input.ageYears;
  return bandMidAge(input.ageBand);
}

/**
 * Suggested alert window for the case on screen. Bounds are always returned
 * inside 10–95 with at least a 10-point span so the alerting stays usable.
 */
export function recommendDepthWindow(input: DepthTargetInputs): DepthTargetRecommendation {
  const icu = isIcu(input.context);
  const age = effectiveAge(input);
  const frailty = (input.frailty ?? "").toLowerCase();
  const regimen = input.regimen ?? null;

  let low = icu ? ICU_DEFAULT.low : GA_DEFAULT.low;
  let high = icu ? ICU_DEFAULT.high : GA_DEFAULT.high;
  const reasons: string[] = [];
  const caveats: string[] = [];
  let touched = false;

  reasons.push(
    icu
      ? "ICU sedation: the usual aim is light sedation, so the window starts at 60–80 rather than the surgical 40–60."
      : "General anaesthesia: starts from the conventional 40–60 surgical band.",
  );

  if (age != null) {
    if (age >= 80) {
      low += 8;
      high += icu ? 5 : 5;
      touched = true;
      reasons.push(
        `Age ${Math.round(age)}: the very old reach any given index at much lower drug exposure and spend far longer in suppression, so the floor is lifted to ${low}.`,
      );
    } else if (age >= 70) {
      low += 5;
      high += icu ? 0 : 3;
      touched = true;
      reasons.push(
        `Age ${Math.round(age)}: older patients suppress readily; the floor is lifted to ${low} to keep away from burst suppression.`,
      );
    } else if (age < 18) {
      touched = true;
      caveats.push(
        "Paediatric EEG differs substantially from the adult signal the index was derived on — treat the number as a trend, not a target.",
      );
    }
  } else {
    caveats.push("No age recorded — enter an age to get an age-adjusted target.");
  }

  if (frailty === "moderate" || frailty === "severe") {
    low += 3;
    touched = true;
    reasons.push(
      `${frailty === "severe" ? "Severe" : "Moderate"} frailty: reduced cerebral reserve, so the floor is lifted a further 3 points.`,
    );
  }

  if (regimen === "propofol_ketamine") {
    high += 5;
    touched = true;
    reasons.push(
      "Ketamine raises high-frequency power, so the processed index reads falsely high; the ceiling is widened by 5 points.",
    );
    caveats.push("With ketamine on board, do not treat a high index as light anaesthesia on its own.");
  } else if (regimen === "volatile" || regimen === "volatile_opioid") {
    touched = true;
    caveats.push(
      "Volatile agents produce more slow-wave power than propofol at equivalent clinical depth; expect slightly lower numbers.",
    );
  } else if (regimen === "propofol_opioid") {
    touched = true;
    caveats.push(
      "With an opioid infusion running, hypnotic requirement falls — pair the index with the nociception index before deepening.",
    );
  }

  // Chronic and acute disease: both reduce cerebral reserve and slow the
  // background, so the same processed number reflects deeper anaesthesia.
  const clinical = deriveClinicalCovariates({
    chronicConditions: input.chronicConditions ?? [],
    acutePathology: input.acutePathology ?? [],
  });
  if (clinical.chronicBurden === "multiple" || clinical.chronicBurden === "high") {
    low += clinical.chronicBurden === "high" ? 4 : 2;
    touched = true;
    reasons.push(
      `${clinicalLevelLabel("chronic", clinical.chronicBurden)}: comorbid burden reduces reserve, so the floor is lifted to ${Math.round(low)}.`,
    );
  }
  if (clinical.chronicCns === "present") {
    low += 3;
    touched = true;
    reasons.push(
      "Chronic neurological disease: baseline slowing lowers the index independently of drug effect, so the floor is lifted a further 3 points.",
    );
    caveats.push(
      "With chronic neurological disease the index reads low at any given drug level — treat trends, not absolute values.",
    );
  }
  if (clinical.acuteClass === "systemic" || clinical.acuteClass === "mixed") {
    low += 4;
    touched = true;
    reasons.push(
      "Acute systemic illness (sepsis, shock, organ failure): encephalopathic slowing means suppression occurs at much lower drug exposure.",
    );
  }
  if (clinical.acuteClass === "neuro" || clinical.acuteClass === "mixed") {
    touched = true;
    caveats.push(
      "Acute neurological pathology: suppression and asymmetry may reflect the injury rather than the anaesthetic — interpret alongside the raw EEG.",
    );
  }

  low = Math.max(10, Math.min(85, Math.round(low)));
  high = Math.max(low + 10, Math.min(95, Math.round(high)));

  const label = icu
    ? age != null && age >= 70
      ? "ICU sedation, older patient"
      : "ICU sedation"
    : age != null && age >= 70
      ? "General anaesthesia, older patient"
      : "General anaesthesia";

  if (regimen) {
    reasons.push(`Regimen recorded as ${regimenLabel(regimen)?.toLowerCase() ?? regimen}.`);
  }

  return { low, high, label, reasons, caveats, isDefault: !touched };
}

/** "45–65" */
export function formatWindow(low: number, high: number): string {
  return `${low}–${high}`;
}
