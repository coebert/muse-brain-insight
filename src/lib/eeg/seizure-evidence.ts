/**
 * Interpretable evidence behind a seizure-suspicion event.
 *
 * The detector is a weighted score over three EEG features. Rather than showing
 * only the final number, every seizure event carries the feature values that
 * produced it, how much each one contributed, the signal-quality context, and
 * the caveats a clinician needs before acting on it.
 */
export interface SeizureFeatureEvidence {
  key: "rhythmicity" | "lineLength" | "ictalBand";
  label: string;
  /** Raw measured value, already formatted for display. */
  value: string;
  /** 0–1 normalised feature score. */
  score: number;
  /** Share of the final score contributed by this feature (0–1). */
  share: number;
  /** Plain-language meaning of this feature. */
  meaning: string;
}

export interface SeizureEvidence {
  /** 0–1 confidence that the detection reflects real EEG, not artefact. */
  confidence: number;
  /** Peak detector score reached during the run (0–1). */
  peakScore: number;
  /** Detector threshold in force at the time. */
  threshold: number;
  /** Consecutive qualifying epochs required, and how many were seen. */
  epochsRequired: number;
  epochsObserved: number;
  /** Mean signal-quality score across the run (0–1). */
  signalQuality: number;
  /** Peak EMG contamination index across the run (0–1). */
  emgIndex: number;
  features: SeizureFeatureEvidence[];
  /** One-line plain-language explanation of why this fired. */
  explanation: string;
  /** Things that could make this a false positive, or weaken it. */
  caveats: string[];
}

export interface SeizureEvidenceInput {
  peakScore: number;
  threshold: number;
  epochsRequired: number;
  epochsObserved: number;
  rhythmicity: number;
  lineLengthRatio: number;
  ictalFraction: number;
  signalQuality: number;
  emgIndex: number;
  confidence: number;
  durationSeconds: number;
}

const WEIGHTS = { rhythmicity: 0.45, lineLength: 0.3, ictalBand: 0.25 } as const;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Word label for a 0–1 confidence, matching the tiles' confidence bands. */
export function confidenceWord(c: number): "high" | "moderate" | "low" {
  return c >= 0.75 ? "high" : c >= 0.45 ? "moderate" : "low";
}

/** Builds the interpretable evidence bundle attached to a seizure event. */
export function buildSeizureEvidence(input: SeizureEvidenceInput): SeizureEvidence {
  const rhythmScore = clamp01(input.rhythmicity);
  const llScore = clamp01((input.lineLengthRatio - 1.6) / 2.4);
  const ictalScore = clamp01((input.ictalFraction - 0.35) / 0.45);

  const contributions = {
    rhythmicity: WEIGHTS.rhythmicity * rhythmScore,
    lineLength: WEIGHTS.lineLength * llScore,
    ictalBand: WEIGHTS.ictalBand * ictalScore,
  };
  const total = contributions.rhythmicity + contributions.lineLength + contributions.ictalBand || 1;

  const features: SeizureFeatureEvidence[] = [
    {
      key: "rhythmicity",
      label: "Rhythmicity",
      value: `${(rhythmScore * 100).toFixed(0)} %`,
      score: rhythmScore,
      share: contributions.rhythmicity / total,
      meaning:
        "How repetitive and narrow-band the waveform is. Seizures are hypersynchronous and rhythmic; normal background is irregular.",
    },
    {
      key: "lineLength",
      label: "Line length vs baseline",
      value: `${input.lineLengthRatio.toFixed(2)}×`,
      score: llScore,
      share: contributions.lineLength / total,
      meaning:
        "Total waveform excursion compared with this patient's own recent background. Rises when discharges grow in amplitude or frequency.",
    },
    {
      key: "ictalBand",
      label: "Ictal-band power",
      value: `${(input.ictalFraction * 100).toFixed(0)} % of total`,
      score: ictalScore,
      share: contributions.ictalBand / total,
      meaning: "Share of power in the 3–13 Hz range where most electrographic seizures evolve.",
    },
  ];

  const lead = [...features].sort((a, b) => b.share - a.share)[0];
  const word = confidenceWord(input.confidence);
  const explanation =
    `Score ${input.peakScore.toFixed(2)} vs threshold ${input.threshold.toFixed(2)} over ` +
    `${input.epochsObserved} consecutive epoch(s) (${input.durationSeconds.toFixed(0)} s). ` +
    `Driven mainly by ${lead ? lead.label.toLowerCase() : "rhythmic activity"} ` +
    `(${lead ? (lead.share * 100).toFixed(0) : "0"} % of the score). ` +
    `Signal quality ${(input.signalQuality * 100).toFixed(0)} %, so overall confidence is ${word}.`;

  const caveats: string[] = [];
  if (input.confidence < 0.45) {
    caveats.push("Low confidence — the signal underneath this detection was noisy or immature.");
  }
  if (input.emgIndex > 0.3) {
    caveats.push(
      "EMG contamination present: shivering, chewing and facial muscle activity mimic rhythmic discharges.",
    );
  }
  if (input.signalQuality < 0.5) {
    caveats.push("Poor electrode contact during the run — check the raw waveform before acting.");
  }
  if (input.durationSeconds < 10) {
    caveats.push("Short run (<10 s) — brief rhythmic bursts are frequently artefactual.");
  }
  if (rhythmScore > 0.6 && llScore < 0.2) {
    caveats.push(
      "Rhythmic but without amplitude escalation — consider ventilator, tremor or chest physiotherapy artefact.",
    );
  }
  caveats.push(
    "Frontal 4-electrode montage cannot localise or exclude seizures; confirm with formal EEG if suspicion persists.",
  );

  return {
    confidence: clamp01(input.confidence),
    peakScore: input.peakScore,
    threshold: input.threshold,
    epochsRequired: input.epochsRequired,
    epochsObserved: input.epochsObserved,
    signalQuality: clamp01(input.signalQuality),
    emgIndex: clamp01(input.emgIndex),
    features,
    explanation,
    caveats,
  };
}
