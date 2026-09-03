/**
 * Cross-dataset harmonisation — making external EEG comparable to this app's
 * own frontal montage, and saying exactly what was done to it.
 *
 * Every collection the model pool draws on was recorded differently: a
 * mastoid-referenced clinical montage records roughly twice the frontal
 * amplitude of a short bipolar forehead derivation; a Cz reference attenuates
 * the frontal delta the depth index leans on; sample rates and anti-alias
 * bandwidths differ, so the same "gamma" band is not the same measurement.
 * Pooling those numbers untouched teaches the model dataset identity rather
 * than physiology.
 *
 * Harmonisation therefore does two things, and only two:
 *
 *   1. It applies a documented, reversible spectral gain (and a band-limit)
 *      that brings a source montage onto the reference target below. The
 *      corrections are *approximate* scaling factors from the montage
 *      literature, not measured per-subject transfer functions, so they are
 *      always labelled `approximate` and carry a confidence.
 *
 *   2. It records the transformation in full — source montage, reference,
 *      bandwidth, every step, every gain, and what could not be corrected —
 *      so any model fitted on external data can be audited back to what the
 *      raw dataset actually contained.
 *
 * Nothing here invents data: if a source cannot reach the target (no gamma
 * band because the dataset was low-passed at 25 Hz), the affected features are
 * marked unusable rather than extrapolated.
 */

import type { PhysionetBands, PhysionetEpoch } from "./physionet";

export const HARMONIZATION_VERSION = "harmonise-1.0.0";

/** The montage every pooled epoch is expressed on after harmonisation. */
export const HARMONIZATION_TARGET = {
  montage: "frontal-bipolar",
  /** AF7–AF8 style short frontal derivation, as the headband records. */
  derivation: "AF7-AF8",
  reference: "bipolar-frontal",
  lowHz: 0.5,
  highHz: 30,
  sampleRateHz: 256,
} as const;

export type ReferenceScheme =
  | "bipolar-frontal"
  | "mastoid"
  | "linked-ears"
  | "average"
  | "cz"
  | "unknown";

export interface SourceMontage {
  /** Channel label as the dataset publishes it, e.g. "FP1" or "F7-A1". */
  channel: string | null;
  reference: ReferenceScheme;
  /** Dataset passband, when documented. */
  lowHz: number | null;
  highHz: number | null;
  sampleRateHz: number | null;
  /** Free-text note kept verbatim for the audit record. */
  note?: string | null;
}

export interface HarmonizationStep {
  step: string;
  detail: string;
  /** Spectral gain applied by this step, dB (positive = power raised). */
  gainDb?: number;
}

export interface HarmonizationRecord {
  version: string;
  target: typeof HARMONIZATION_TARGET;
  source: SourceMontage;
  steps: HarmonizationStep[];
  /** Total spectral gain applied across all steps, dB. */
  totalGainDb: number;
  /** How much of the target band the source can actually support (0–1). */
  bandCoverage: number;
  /** Bands that must not be used from this source. */
  unusableBands: (keyof PhysionetBands)[];
  /** 0–1 confidence that the harmonised values are comparable to the target. */
  confidence: number;
  /** Always true: these are literature scaling factors, not measured ones. */
  approximate: true;
  /** Anything the transform could not correct, stated plainly. */
  caveats: string[];
}

export interface HarmonizedEpoch extends PhysionetEpoch {
  harmonization: HarmonizationRecord;
}

/* ------------------------------------------------- reference correction --- */

/**
 * Approximate amplitude ratio of a frontal signal on each reference scheme
 * relative to the short bipolar frontal derivation the target uses. Power
 * gain is the square of this ratio, applied as its reciprocal to bring the
 * source down (or up) onto the target scale.
 */
const REFERENCE_AMPLITUDE_RATIO: Record<ReferenceScheme, number> = {
  "bipolar-frontal": 1,
  // Long inter-electrode distance to an inactive ear/mastoid: larger swings.
  mastoid: 2.0,
  "linked-ears": 1.9,
  // Common-average removes shared frontal delta, so amplitudes sit lower.
  average: 1.4,
  // Cz sits near the frontal signal, cancelling much of the low-frequency swing.
  cz: 1.2,
  unknown: 1,
};

const REFERENCE_CONFIDENCE: Record<ReferenceScheme, number> = {
  "bipolar-frontal": 1,
  mastoid: 0.8,
  "linked-ears": 0.8,
  average: 0.65,
  cz: 0.6,
  unknown: 0.4,
};

/** Infer the reference scheme from a published channel label when possible. */
export function inferReference(channel: string | null | undefined): ReferenceScheme {
  const c = (channel ?? "").trim().toUpperCase();
  if (!c) return "unknown";
  if (/-(A1|A2|M1|M2)$/.test(c)) return "mastoid";
  if (/-(LE|EARS?|A1A2)$/.test(c)) return "linked-ears";
  if (/-(AVG|AVE|AVERAGE|REF)$/.test(c)) return "average";
  if (/-CZ$/.test(c)) return "cz";
  if (/^(AF7|AF8|FP1|FP2|F7|F8)-(AF7|AF8|FP1|FP2|F7|F8)$/.test(c)) return "bipolar-frontal";
  return "unknown";
}

const BAND_EDGES: Record<keyof PhysionetBands, [number, number]> = {
  delta: [0.5, 4],
  theta: [4, 8],
  alpha: [8, 13],
  beta: [13, 30],
  gamma: [30, 45],
};

/** Bands the source passband cannot support. */
function unusableBands(source: SourceMontage): (keyof PhysionetBands)[] {
  const lo = source.lowHz ?? HARMONIZATION_TARGET.lowHz;
  const hi =
    source.highHz ??
    (source.sampleRateHz ? Math.min(source.sampleRateHz / 2.5, 45) : 45);
  return (Object.keys(BAND_EDGES) as (keyof PhysionetBands)[]).filter((b) => {
    const [bl, bh] = BAND_EDGES[b];
    // More than half the band outside the source passband is not recoverable.
    const overlap = Math.max(0, Math.min(bh, hi) - Math.max(bl, lo));
    return overlap < (bh - bl) * 0.5;
  });
}

/** Build the transform for a source montage without applying it. */
export function planHarmonization(source: SourceMontage): HarmonizationRecord {
  const steps: HarmonizationStep[] = [];
  const caveats: string[] = [];

  const ratio = REFERENCE_AMPLITUDE_RATIO[source.reference];
  const refGainDb = -20 * Math.log10(ratio);
  steps.push({
    step: "reference-normalisation",
    detail: `${source.reference} → ${HARMONIZATION_TARGET.reference} (amplitude ratio ${ratio.toFixed(2)}×, approximate)`,
    gainDb: Math.round(refGainDb * 100) / 100,
  });
  if (source.reference === "unknown") {
    caveats.push("Reference scheme was not documented; no reference gain applied.");
  }

  const lo = source.lowHz ?? HARMONIZATION_TARGET.lowHz;
  const hi = source.highHz ?? (source.sampleRateHz ? source.sampleRateHz / 2.5 : 45);
  steps.push({
    step: "band-limit",
    detail: `source ${lo}–${Math.round(hi)} Hz restricted to target ${HARMONIZATION_TARGET.lowHz}–${HARMONIZATION_TARGET.highHz} Hz`,
  });

  if (source.sampleRateHz && source.sampleRateHz !== HARMONIZATION_TARGET.sampleRateHz) {
    steps.push({
      step: "spectral-regrid",
      detail: `${source.sampleRateHz} Hz native rate resampled onto the 0.5 Hz DSA grid`,
    });
  }

  const bad = unusableBands(source);
  if (bad.length) {
    caveats.push(
      `Source passband cannot support: ${bad.join(", ")} — these features are withheld from pooled fitting.`,
    );
  }

  const targetSpan = HARMONIZATION_TARGET.highHz - HARMONIZATION_TARGET.lowHz;
  const coverage = Math.max(
    0,
    Math.min(
      1,
      (Math.min(hi, HARMONIZATION_TARGET.highHz) - Math.max(lo, HARMONIZATION_TARGET.lowHz)) /
        targetSpan,
    ),
  );

  const totalGainDb = steps.reduce((acc, s) => acc + (s.gainDb ?? 0), 0);
  const confidence =
    Math.round(REFERENCE_CONFIDENCE[source.reference] * (0.5 + 0.5 * coverage) * 100) / 100;

  if (!source.channel) {
    caveats.push("Channel label absent; montage inferred from dataset defaults.");
  }
  caveats.push(
    "Scaling factors are literature approximations, not per-subject transfer functions.",
  );

  return {
    version: HARMONIZATION_VERSION,
    target: HARMONIZATION_TARGET,
    source,
    steps,
    totalGainDb: Math.round(totalGainDb * 100) / 100,
    bandCoverage: Math.round(coverage * 1000) / 1000,
    unusableBands: bad,
    confidence,
    approximate: true,
    caveats,
  };
}

/**
 * Apply the planned transform to one epoch's DSA features.
 *
 * Spectral shape is preserved; only the level is corrected, so SEF95 and the
 * suppression verdict are untouched by design — a gain cannot change which
 * frequency holds 95 % of the power, and re-deriving a suppression label from
 * rescaled power would fabricate a detector verdict the dataset never gave.
 */
export function harmonizeEpoch(
  epoch: PhysionetEpoch,
  source: SourceMontage,
  plan?: HarmonizationRecord,
): HarmonizedEpoch {
  const record = plan ?? planHarmonization(source);
  const gainDb = record.totalGainDb;
  const linear = Math.pow(10, gainDb / 10);

  const bands: PhysionetBands = { ...epoch.bands };
  for (const key of Object.keys(bands) as (keyof PhysionetBands)[]) {
    bands[key] = record.unusableBands.includes(key) ? 0 : bands[key] * linear;
  }
  const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma;

  return {
    ...epoch,
    spectrumDb: epoch.spectrumDb.map((v) => Math.round((v + gainDb) * 1000) / 1000),
    bands,
    totalPower,
    harmonization: record,
  };
}

/** Harmonise a whole case, planning once and applying to each epoch. */
export function harmonizeEpochs(
  epochs: PhysionetEpoch[],
  source: SourceMontage,
): HarmonizedEpoch[] {
  const plan = planHarmonization(source);
  return epochs.map((e) => harmonizeEpoch(e, source, plan));
}

/** One-line audit string for reports and model provenance panels. */
export function describeHarmonization(record: HarmonizationRecord): string {
  return (
    `${record.source.reference} → ${record.target.reference}, ` +
    `${record.totalGainDb >= 0 ? "+" : ""}${record.totalGainDb} dB, ` +
    `coverage ${(record.bandCoverage * 100).toFixed(0)}%, ` +
    `confidence ${(record.confidence * 100).toFixed(0)}% (${record.version})`
  );
}
