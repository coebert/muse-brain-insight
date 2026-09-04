/**
 * Declared-drug EEG signatures for COEBIS.
 *
 * Ketamine was the first case of a general problem: every processed depth index
 * in clinical use — BIS, Entropy, PSI and the published OpenIBIS algorithm this
 * app re-implements — was derived on GABAergic anaesthesia. A drug whose EEG
 * signature differs from propofol's therefore biases the number in a direction
 * that has nothing to do with how deep the patient is. This module generalises
 * the ketamine stage to the other agents where that bias is documented, and is
 * explicit about the agents where correcting would be wrong.
 *
 * What is corrected, and which way:
 *
 *  - Nitrous oxide, xenon (NMDA antagonists): frontal beta/gamma augmentation
 *    with preserved slow activity, and — for N2O especially — little or no
 *    index change at anaesthetic concentrations. The index reads light.
 *    Corrected DOWN.
 *  - Benzodiazepines (midazolam): the classic sedative beta buzz at low dose.
 *    The index reads light. Corrected DOWN, and by less than ketamine, because
 *    the effect is smaller and the patient really is only sedated.
 *  - Dexmedetomidine: produces spindle-rich, slow-wave NREM-like sleep. The
 *    index reads deep while the patient remains rousable to voice, which is the
 *    hazard that matters for sedation targets. Corrected UP.
 *
 * What is deliberately NOT corrected:
 *
 *  - Propofol and the volatile agents. These *are* the reference drugs. Their
 *    signature — alpha/delta anteriorisation, slowing, then suppression — is
 *    the depth being measured. Subtracting it would subtract the signal and
 *    leave the index reporting nothing. They are registered here as reference
 *    agents so the UI can say so rather than staying silent.
 *  - Opioids at clinical doses, which change the frontal EEG very little, and
 *    neuromuscular blockade, whose effect is removal of EMG contamination and
 *    is handled by the artefact/EMG path rather than by a drug subtraction.
 *
 * The same three safeguards as the ketamine stage apply throughout: a
 * declaration in the case record is required (an EEG pattern alone only ever
 * raises an advisory), every movement is capped and bounded so it cannot
 * manufacture depth or wakefulness, and nothing here touches the raw OpenIBIS
 * index or the paired readings COEBIS is fitted on.
 */

import {
  KETAMINE_CAP,
  KETAMINE_FLOOR,
  ketamineScore,
  type KetamineFeatures,
} from "./ketamine";

export type DrugKey =
  | "ketamine"
  | "nitrous_oxide"
  | "xenon"
  | "benzodiazepine"
  | "dexmedetomidine"
  | "propofol"
  | "volatile"
  | "opioid";

/** How a declared agent is treated by the depth stage. */
export type DrugRole =
  /** Its signature biases the index; a bounded correction is available. */
  | "corrected"
  /** The index was derived on it — its signature is the measurement. */
  | "reference"
  /** Declared, but no frontal-EEG bias worth correcting. */
  | "neutral";

export interface DrugSpec {
  key: DrugKey;
  label: string;
  role: DrugRole;
  /** Direction of the correction: -1 pulls the index down, +1 pushes it up. */
  direction: -1 | 0 | 1;
  /** Largest movement this agent may make, in index points. */
  cap: number;
  /** Downward corrections stop here; upward corrections stop at `ceiling`. */
  floor?: number;
  ceiling?: number;
  /** Words that identify the agent in a regimen, note or marker. */
  match: RegExp;
  /** Plain-language reason shown when the agent is declared. */
  rationale: string;
}

/** No combination of declared agents may move the index further than this. */
export const MAX_DRUG_TOTAL = 16;
/** Pattern strength at which an undeclared agent's signature is worth an advisory. */
export const ADVISORY_SCORE = 0.4;

export const DRUG_SPECS: DrugSpec[] = [
  {
    key: "ketamine",
    label: "Ketamine",
    role: "corrected",
    direction: -1,
    cap: KETAMINE_CAP,
    floor: KETAMINE_FLOOR,
    match: /ketamine|esketamine/i,
    rationale:
      "NMDA antagonism augments 13–47 Hz power and abolishes the propofol alpha spindle, so a ratio-based index reads high while the patient is not lighter.",
  },
  {
    key: "nitrous_oxide",
    label: "Nitrous oxide",
    role: "corrected",
    direction: -1,
    cap: 8,
    floor: 45,
    match: /nitrous|n2o|entonox/i,
    rationale:
      "Nitrous oxide adds frontal fast activity and is well documented to leave the processed index almost unchanged at anaesthetic concentrations, so the number understates the depth it contributes.",
  },
  {
    key: "xenon",
    label: "Xenon",
    role: "corrected",
    direction: -1,
    cap: 8,
    floor: 45,
    match: /xenon/i,
    rationale:
      "Xenon is an NMDA antagonist and produces the same activated frontal pattern as ketamine, with the same upward bias on the index.",
  },
  {
    key: "benzodiazepine",
    label: "Benzodiazepine",
    role: "corrected",
    direction: -1,
    cap: 6,
    floor: 55,
    match: /midazolam|diazepam|lorazepam|benzodiazepine/i,
    rationale:
      "Benzodiazepines produce prominent frontal beta at sedative doses, which a ratio-based index reads as arousal. The correction is small: the patient genuinely is only sedated.",
  },
  {
    key: "dexmedetomidine",
    label: "Dexmedetomidine",
    role: "corrected",
    direction: 1,
    cap: 8,
    ceiling: 75,
    match: /dexmedetomidine|dexmed|precedex|clonidine/i,
    rationale:
      "Alpha-2 agonists produce spindle-rich NREM-like sleep, so the index reads deep while the patient is still rousable to voice. The correction is upward and stops short of reporting wakefulness.",
  },
  {
    key: "propofol",
    label: "Propofol",
    role: "reference",
    direction: 0,
    cap: 0,
    match: /propofol|tiva/i,
    rationale:
      "Propofol is the agent the index was derived on. Its alpha/delta signature is the depth being measured, so nothing is subtracted for it.",
  },
  {
    key: "volatile",
    label: "Volatile agent",
    role: "reference",
    direction: 0,
    cap: 0,
    match: /sevoflurane|isoflurane|desflurane|volatile|inhalational/i,
    rationale:
      "Volatile anaesthesia produces the same GABAergic slowing the index was calibrated against, so its signature is measurement rather than bias.",
  },
  {
    key: "opioid",
    label: "Opioid",
    role: "neutral",
    direction: 0,
    cap: 0,
    match: /remifentanil|fentanyl|alfentanil|sufentanil|morphine|opioid/i,
    rationale:
      "Opioids change the frontal EEG very little at clinical doses; they alter the response to stimulation rather than the index itself, so no correction is applied.",
  },
];

export const DRUG_BY_KEY = new Map(DRUG_SPECS.map((d) => [d.key, d]));

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Agents named in a regimen label, free-text note, marker or Ce entry. */
export function declaredDrugs(input: {
  regimen?: string | null;
  notes?: (string | null | undefined)[] | null;
  ce?: Record<string, unknown> | null;
}): DrugKey[] {
  const text = [input.regimen ?? "", ...(input.notes ?? []).map((n) => n ?? "")].join(" ");
  const found = new Set<DrugKey>();
  for (const spec of DRUG_SPECS) {
    if (text && spec.match.test(text)) found.add(spec.key);
    for (const [drug, value] of Object.entries(input.ce ?? {})) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0 && spec.match.test(drug)) found.add(spec.key);
    }
  }
  return DRUG_SPECS.filter((s) => found.has(s.key)).map((s) => s.key);
}

/**
 * Strength of the spindle-rich slow pattern that makes an alpha-2 agonist read
 * deeper than the patient is: a preserved or exaggerated alpha spindle with
 * abundant slow activity and little fast activity.
 */
export function sedativeSpindleScore(f: KetamineFeatures): number {
  const { alphaFraction: alpha, slowFraction: slow, betaFraction: beta, gammaFraction: gamma } = f;
  if (alpha == null || slow == null) return 0;
  const spindle = clamp((alpha - 0.12) / 0.13, 0, 1);
  const slowWeight = clamp((slow - 0.25) / 0.2, 0, 1);
  const fast = (beta ?? 0) + (gamma ?? 0);
  const quiet = clamp(1 - (fast - 0.1) / 0.15, 0, 1);
  return clamp(spindle * slowWeight * quiet, 0, 1);
}

/** Pattern strength for one agent, 0–1, from the epoch's spectral shares. */
export function drugPatternScore(key: DrugKey, features: KetamineFeatures): number {
  const spec = DRUG_BY_KEY.get(key);
  if (!spec || spec.role !== "corrected") return 0;
  if (spec.direction === 1) return sedativeSpindleScore(features);
  // The NMDA/beta-buzz agents share the ketamine pattern: fast activity above
  // what GABAergic anaesthesia produces, with slow activity preserved.
  return ketamineScore(features).score;
}

export interface DrugSignatureEntry {
  key: DrugKey;
  label: string;
  role: DrugRole;
  /** 0–1 strength of this agent's signature in the current epoch. */
  score: number;
  /** Points this agent moved the index (negative = down). */
  delta: number;
  rationale: string;
}

export interface DrugStage {
  /** Total movement applied to the displayed index, in points. */
  delta: number;
  /** Per-agent detail, declared agents only. */
  entries: DrugSignatureEntry[];
  /** Declared agents whose signature is the measurement, not a bias. */
  reference: DrugKey[];
  /** Undeclared patterns worth mentioning; these never move the number. */
  advisories: string[];
  reasons: string[];
}

export const NO_DRUG_STAGE: DrugStage = {
  delta: 0,
  entries: [],
  reference: [],
  advisories: [],
  reasons: [],
};

export interface DrugStageInputs {
  /** Index after the pooled, covariate and adjunct stages. */
  aligned: number | null;
  features: KetamineFeatures;
  /** Agents recorded for this case. */
  declared: DrugKey[];
  /** Suppression ratio, 0–100 %. */
  bsr: number;
  /** 0–1 signal quality; a poor signal shrinks every correction. */
  quality?: number | null;
  /**
   * Points already removed by an earlier stage handling one of these agents
   * (the standalone ketamine stage), so the combined movement stays bounded and
   * nothing is subtracted twice.
   */
  alreadyApplied?: number;
  /** Agents whose correction is applied elsewhere and must be skipped here. */
  handledElsewhere?: DrugKey[];
}

/**
 * Evaluate every declared agent for this epoch and return the bounded total.
 *
 * Corrections are applied strongest-first and the running total is clipped to
 * {@link MAX_DRUG_TOTAL} (inclusive of anything an earlier stage already
 * applied), so declaring several agents cannot walk the index anywhere.
 */
export function drugStage({
  aligned,
  features,
  declared,
  bsr,
  quality,
  alreadyApplied = 0,
  handledElsewhere = [],
}: DrugStageInputs): DrugStage {
  const entries: DrugSignatureEntry[] = [];
  const reference: DrugKey[] = [];
  const reasons: string[] = [];
  const advisories: string[] = [];
  const declaredSet = new Set(declared);
  const skip = new Set(handledElsewhere);
  const safeBsr = clamp(Number.isFinite(bsr) ? bsr : 0, 0, 100);
  const shrink = quality != null && Number.isFinite(quality) ? clamp(quality, 0.3, 1) : 1;

  // Advisory: an undeclared agent's signature is present. Never acted on — the
  // same pattern is produced by EMG, arousal and light anaesthesia.
  for (const spec of DRUG_SPECS) {
    if (spec.role !== "corrected" || declaredSet.has(spec.key)) continue;
    if (spec.key === "ketamine") continue; // its own stage raises this advisory
    // The spindle-rich slow pattern an alpha-2 agonist produces is also the
    // ordinary signature of propofol and the volatiles, so it identifies no
    // drug on its own. Advising on it would warn on every routine GABAergic
    // anaesthetic. These agents are corrected only when they are recorded.
    if (spec.direction === 1) continue;
    if (drugPatternScore(spec.key, features) >= ADVISORY_SCORE) {
      advisories.push(
        `The spectrum shows the pattern ${spec.label.toLowerCase()} produces, but it is not recorded for this case. If it is running, the index is biased; record it so COEBIS can correct for it.`,
      );
    }
  }

  for (const key of declared) {
    const spec = DRUG_BY_KEY.get(key);
    if (!spec) continue;
    if (spec.role !== "corrected") {
      if (spec.role === "reference") reference.push(spec.key);
      reasons.push(`${spec.label}: ${spec.rationale}`);
      continue;
    }
    if (skip.has(key)) continue;
    const score = drugPatternScore(key, features);
    if (score <= 0 || aligned == null) {
      entries.push({ key, label: spec.label, role: spec.role, score: 0, delta: 0, rationale: spec.rationale });
      continue;
    }
    entries.push({
      key,
      label: spec.label,
      role: spec.role,
      score: Number(score.toFixed(3)),
      delta: 0,
      rationale: spec.rationale,
    });
  }

  // Suppression governs the number in its own right; no drug stage runs into it.
  if (aligned == null || safeBsr >= 20) {
    return { delta: 0, entries, reference, advisories, reasons };
  }

  let value = aligned;
  let total = alreadyApplied;
  const scored = entries
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const entry of scored) {
    const spec = DRUG_BY_KEY.get(entry.key)!;
    const room = MAX_DRUG_TOTAL - Math.abs(total);
    if (room <= 0) break;
    const wanted = spec.direction * Math.min(spec.cap * entry.score * shrink, room);
    let delta = wanted;
    if (spec.direction < 0 && spec.floor != null) {
      delta = Math.max(delta, Math.min(0, spec.floor - value));
    }
    if (spec.direction > 0 && spec.ceiling != null) {
      delta = Math.min(delta, Math.max(0, spec.ceiling - value));
    }
    delta = Number(delta.toFixed(2));
    if (delta === 0) continue;
    entry.delta = delta;
    value = clamp(value + delta, 0, 100);
    total += delta;
    reasons.push(
      `${spec.label}: ${Math.abs(delta).toFixed(1)} index points treated as drug signature rather than ${
        spec.direction < 0 ? "wakefulness" : "depth"
      } (capped at ${spec.cap}${
        spec.direction < 0 && spec.floor != null
          ? `, never below ${spec.floor} on this rule alone`
          : spec.ceiling != null
            ? `, never above ${spec.ceiling} on this rule alone`
            : ""
      }). ${spec.rationale}`,
    );
  }

  const delta = Number(entries.reduce((a, e) => a + e.delta, 0).toFixed(2));
  return { delta, entries, reference, advisories, reasons };
}

/** One-line summary for a badge, or null when there is nothing to say. */
export function drugStageHint(stage: DrugStage | null | undefined): string | null {
  if (!stage) return null;
  const moved = stage.entries.filter((e) => e.delta !== 0);
  if (moved.length) {
    const names = moved.map((e) => e.label.toLowerCase()).join(", ");
    return `Drug-signature correction ${stage.delta > 0 ? "+" : "−"}${Math.abs(stage.delta).toFixed(0)}: ${names} accounted for.`;
  }
  if (stage.advisories.length) return stage.advisories[0]!;
  return null;
}
