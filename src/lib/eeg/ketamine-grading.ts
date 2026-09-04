/**
 * Does the ketamine subtraction make COEBIS agree better with the truth?
 *
 * The per-case page shows *where* the correction moves the number. This module
 * answers the only question that licenses it clinically: graded against
 * independently recorded labels — monitor suppression ratio and recorded depth
 * state — is the index closer to the truth after the subtraction than before?
 *
 * Two arms, kept strictly apart:
 *
 *  - **declared** — cases whose record names ketamine. This is the only arm
 *    that is evidence. The subtraction is live on these cases, so the
 *    before/after difference is what the patient's clinician actually sees.
 *  - **counterfactual** — cases that carry the fast-frequency pattern but do
 *    not record ketamine. Nothing is subtracted on them in the app, and nothing
 *    here changes that. The arm exists to show what the rule *would* do if such
 *    a case were declared. It cannot validate the rule: with no ketamine in the
 *    record there is no reason to believe the pattern is ketamine rather than
 *    light anaesthesia, EMG or arousal — and if it is light anaesthesia, a
 *    "better" grade would mean the rule is hiding a genuinely light patient.
 *
 * Two graded axes:
 *
 *  - **depth state** — discrimination of anaesthetised from awake epochs
 *    (AUC, and sensitivity/specificity at the working threshold), before and
 *    after. This is where a correct subtraction should help: it moves epochs
 *    that read spuriously light back below the threshold.
 *  - **suppression** — the app's own suppression ratio is untouched by the
 *    subtraction, so its concordance with the monitor label cannot change and
 *    is reported unchanged, deliberately. What can change is how the *index*
 *    reads during recorded suppression, so that is graded before and after: a
 *    subtraction that pushed the index up inside suppression would be a fault.
 *
 * Sufficiency uses the same bar as the pathology grading: nothing is called
 * reliable without {@link MIN_AXIS_EPOCHS} labelled epochs and
 * {@link MIN_AXIS_CASES} independent cases on each side.
 */

import { rocAuc } from "./diagnosis-model";
import {
  MIN_AXIS_CASES,
  MIN_AXIS_EPOCHS,
  type DepthStateLabel,
  type Sufficiency,
  type SuppressionLabel,
} from "./pathology-labels";
import {
  ANAESTHESIA_THRESHOLD,
  APP_SUPPRESSED_PCT,
  epochSignature,
  PATTERN_POSITIVE,
  type KetamineCaseEpoch,
} from "./ketamine-cases";
import { ketamineScore } from "./ketamine";

export type GradingArm = "declared" | "counterfactual";

/** One epoch reduced to the two numbers the grading compares. */
export interface GradedEpoch {
  caseRef: string;
  /** Index before the ketamine stage. */
  before: number;
  /** Index after it — identical when the stage did not move this epoch. */
  after: number;
  suppressionPct: number | null;
  suppressionLabel: SuppressionLabel | null;
  /** Only the two unambiguous states are graded; induction/emergence are dropped. */
  stateLabel: DepthStateLabel | null;
}

export interface StateDiscrimination {
  anaesthetised: number;
  awake: number;
  cases: number;
  auc: number | null;
  /** Sensitivity for "anaesthetised" at the working threshold. */
  sensitivity: number | null;
  /** Specificity — awake epochs correctly left above the threshold. */
  specificity: number | null;
  /** Mean awake index minus mean anaesthetised index, in points. */
  separation: number | null;
  /** Anaesthetised epochs the index wrongly reads as awake. */
  falselyLight: number;
}

export interface SuppressionReading {
  labelled: number;
  cases: number;
  /** Concordance of the app's suppression ratio with the label. Unchanged by the stage. */
  concordance: number | null;
  /** Mean index over epochs the monitor labelled suppressed. */
  meanIndexSuppressed: number | null;
  /** Suppressed epochs where the index nonetheless reads above the threshold. */
  falselyLight: number;
}

export interface ArmGrade {
  arm: GradingArm;
  cases: number;
  epochs: number;
  /** Epochs the subtraction actually moved. */
  moved: number;
  /** Mean movement over moved epochs, in points (negative = down). */
  meanDelta: number | null;
  state: { before: StateDiscrimination; after: StateDiscrimination; aucGain: number | null };
  suppression: { before: SuppressionReading; after: SuppressionReading };
  sufficiency: Sufficiency;
  /** Plain-language verdict for this arm. */
  verdict: string;
}

export interface KetamineGradingReport {
  arms: ArmGrade[];
  /** Cases whose record names ketamine, across the whole pool. */
  declaredCases: number;
  /** Cases carrying the pattern without a declaration. */
  patternedCases: number;
  notes: string[];
}

function round(v: number | null, dp = 3): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function sufficiencyOf(n: number, posCases: number, negCases: number): Sufficiency {
  if (n >= MIN_AXIS_EPOCHS && posCases >= MIN_AXIS_CASES && negCases >= MIN_AXIS_CASES) {
    return "sufficient";
  }
  if (n >= Math.ceil(MIN_AXIS_EPOCHS / 4) && posCases >= 1 && negCases >= 1) return "provisional";
  return "insufficient";
}

function discriminate(epochs: GradedEpoch[], pick: (e: GradedEpoch) => number): StateDiscrimination {
  const labelled = epochs.filter(
    (e) => e.stateLabel === "anaesthetised" || e.stateLabel === "awake",
  );
  const anaes = labelled.filter((e) => e.stateLabel === "anaesthetised");
  const awake = labelled.filter((e) => e.stateLabel === "awake");
  // Higher index = more awake, so the AUC is taken with "awake" as positive.
  const auc = rocAuc(labelled.map(pick), labelled.map((e) => e.stateLabel === "awake"));
  const falselyLight = anaes.filter((e) => pick(e) > ANAESTHESIA_THRESHOLD).length;
  return {
    anaesthetised: anaes.length,
    awake: awake.length,
    cases: new Set(labelled.map((e) => e.caseRef)).size,
    auc: round(auc),
    sensitivity: anaes.length ? round((anaes.length - falselyLight) / anaes.length) : null,
    specificity: awake.length
      ? round(awake.filter((e) => pick(e) > ANAESTHESIA_THRESHOLD).length / awake.length)
      : null,
    separation: round(
      mean(awake.map(pick)) != null && mean(anaes.map(pick)) != null
        ? (mean(awake.map(pick)) as number) - (mean(anaes.map(pick)) as number)
        : null,
      2,
    ),
    falselyLight,
  };
}

function suppressionReading(
  epochs: GradedEpoch[],
  pick: (e: GradedEpoch) => number,
): SuppressionReading {
  const labelled = epochs.filter((e) => e.suppressionLabel != null);
  const withApp = labelled.filter((e) => e.suppressionPct != null);
  const agree = withApp.filter(
    (e) => (e.suppressionPct as number) >= APP_SUPPRESSED_PCT === (e.suppressionLabel === "suppressed"),
  ).length;
  const suppressed = labelled.filter((e) => e.suppressionLabel === "suppressed");
  return {
    labelled: labelled.length,
    cases: new Set(labelled.map((e) => e.caseRef)).size,
    concordance: withApp.length ? round(agree / withApp.length) : null,
    meanIndexSuppressed: round(mean(suppressed.map(pick)), 2),
    falselyLight: suppressed.filter((e) => pick(e) > ANAESTHESIA_THRESHOLD).length,
  };
}

function verdictFor(arm: GradingArm, grade: Omit<ArmGrade, "verdict">): string {
  if (!grade.epochs) {
    return arm === "declared"
      ? "No case in the pool records ketamine, so the subtraction has graded nothing. Until a ketamine case with independent labels is ingested, the rule stands on published pharmacology, not on evidence from this data."
      : "No case carries the fast-frequency pattern strongly enough to model.";
  }
  if (!grade.moved) {
    return "The subtraction moved no epoch in this arm — either the pattern never cleared its threshold or every epoch was inside suppression, where the stage stands down.";
  }
  const gain = grade.state.aucGain;
  const insufficient = grade.sufficiency !== "sufficient";
  const direction =
    gain == null
      ? "There are not enough labelled epochs on both sides to say whether discrimination changed."
      : gain > 0.01
        ? `Discrimination improves: AUC ${grade.state.before.auc} → ${grade.state.after.auc} against the recorded depth state.`
        : gain < -0.01
          ? `Discrimination worsens: AUC ${grade.state.before.auc} → ${grade.state.after.auc}. On this data the subtraction is not helping.`
          : `Discrimination is unchanged (AUC ${grade.state.before.auc} → ${grade.state.after.auc}); the subtraction moves the number without changing which epochs are called anaesthetised.`;
  const caveat =
    arm === "counterfactual"
      ? " This arm is hypothetical: nothing is subtracted on these cases in the app, and a pattern with no drug record is just as likely to be a genuinely light patient, in which case an apparent gain is the rule hiding lightness."
      : insufficient
        ? ` Below the reliability bar of ${MIN_AXIS_EPOCHS} labelled epochs and ${MIN_AXIS_CASES} cases per class — read it as orientation.`
        : "";
  return direction + caveat;
}

function gradeArm(arm: GradingArm, epochs: GradedEpoch[]): ArmGrade {
  const moved = epochs.filter((e) => e.after !== e.before);
  const cases = new Set(epochs.map((e) => e.caseRef));
  const labelled = epochs.filter(
    (e) => e.stateLabel === "anaesthetised" || e.stateLabel === "awake",
  );
  const before = discriminate(epochs, (e) => e.before);
  const after = discriminate(epochs, (e) => e.after);
  const grade: Omit<ArmGrade, "verdict"> = {
    arm,
    cases: cases.size,
    epochs: epochs.length,
    moved: moved.length,
    meanDelta: round(mean(moved.map((e) => e.after - e.before)), 2),
    state: {
      before,
      after,
      aucGain:
        before.auc != null && after.auc != null ? round(after.auc - before.auc) : null,
    },
    suppression: {
      before: suppressionReading(epochs, (e) => e.before),
      after: suppressionReading(epochs, (e) => e.after),
    },
    sufficiency: sufficiencyOf(
      labelled.length,
      new Set(labelled.filter((e) => e.stateLabel === "anaesthetised").map((e) => e.caseRef)).size,
      new Set(labelled.filter((e) => e.stateLabel === "awake").map((e) => e.caseRef)).size,
    ),
  };
  return { ...grade, verdict: verdictFor(arm, grade) };
}

/** Reduce a loaded epoch to its before/after pair using the live ketamine stage. */
export function gradedEpoch(epoch: KetamineCaseEpoch, forceDeclared = false): GradedEpoch | null {
  if (epoch.coebis == null) return null;
  const signature = epochSignature(
    forceDeclared && !epoch.declared ? { ...epoch, declared: true } : epoch,
  );
  const after = Math.max(0, Math.min(100, epoch.coebis + (signature.corrected ? signature.delta : 0)));
  return {
    caseRef: `${epoch.lineage}/${epoch.caseRef}`,
    before: epoch.coebis,
    after: Number(after.toFixed(2)),
    suppressionPct: epoch.suppressionPct,
    suppressionLabel: epoch.suppressionLabel,
    stateLabel: epoch.stateLabel,
  };
}

/**
 * Grade the ketamine subtraction against the recorded labels, declared cases
 * as evidence and patterned-but-undeclared cases as an explicit counterfactual.
 */
export function gradeKetamineSubtraction(epochs: KetamineCaseEpoch[]): KetamineGradingReport {
  const declaredCases = new Set<string>();
  const patternedCases = new Set<string>();
  const declared: GradedEpoch[] = [];
  const counterfactual: GradedEpoch[] = [];

  for (const epoch of epochs) {
    const key = `${epoch.lineage}/${epoch.caseRef}`;
    if (epoch.declared) declaredCases.add(key);
    else if (ketamineScore(epoch.features).score >= PATTERN_POSITIVE) patternedCases.add(key);
  }

  for (const epoch of epochs) {
    const key = `${epoch.lineage}/${epoch.caseRef}`;
    if (declaredCases.has(key)) {
      const row = gradedEpoch(epoch);
      if (row) declared.push(row);
    } else if (patternedCases.has(key)) {
      const row = gradedEpoch(epoch, true);
      if (row) counterfactual.push(row);
    }
  }

  const arms = [gradeArm("declared", declared), gradeArm("counterfactual", counterfactual)];
  const notes: string[] = [];
  if (!declaredCases.size) {
    notes.push(
      "No case currently in the pool records ketamine: the imported corpora are propofol or volatile anaesthesia and no local recording declares it. The declared arm is therefore empty and the subtraction is inert on today's data.",
    );
  }
  notes.push(
    "The app's suppression ratio is computed from the burst pattern and is not touched by the ketamine stage, so its concordance with the monitor label is identical before and after by construction. What is graded there is how the index reads during recorded suppression.",
  );
  notes.push(
    "The counterfactual arm is not validation. It shows what the rule would do if these cases declared ketamine; a pattern without a drug record is equally consistent with a genuinely light patient, and on that reading an apparent improvement would be the correction masking lightness.",
  );
  return { arms, declaredCases: declaredCases.size, patternedCases: patternedCases.size, notes };
}
