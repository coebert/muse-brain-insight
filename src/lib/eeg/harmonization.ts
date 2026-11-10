/**
 * Cross-dataset harmonisation — recording exactly how external EEG differs
 * from this app's own frontal montage, without pretending to correct it.
 *
 * Every collection the model pool draws on was recorded differently: mastoid,
 * linked-ear, average, Cz or device references; different sample rates and
 * anti-alias bandwidths. Those differences are real and they matter.
 *
 * What this module does NOT do (since harmonise-2.0.0):
 *   - It does not re-reference. Re-referencing needs the other electrodes'
 *     signals; a scalar spectral gain cannot turn a mastoid derivation into a
 *     bipolar frontal one, so no reference "gain" is applied. The source
 *     reference is preserved verbatim and a mismatch is a stated caveat.
 *   - It does not infer an average reference from a generic "-REF" label.
 *     "REF" is whatever the amplifier used; without metadata it is unknown.
 *   - It does not write zeros for bands the source passband cannot support.
 *     Those bands are listed as unavailable and left out of the available
 *     band set and the available total; the original values stay untouched.
 *
 * What it does: records source montage, reference, passband and rate, lists
 * unavailable bands, and says whether the record may enter a new fit.
 * Records made by harmonise-1.0.0 applied literature gain factors and zeroed
 * unsupported bands; they are kept as stored but are incompatible with new
 * fits until reprocessed from the original files.
 */

import type { PhysionetBands, PhysionetEpoch } from "./physionet";

export const HARMONIZATION_VERSION = "harmonise-2.0.0";
/** Versions that applied invented reference gains or zeroed bands. */
export const LEGACY_HARMONIZATION_VERSIONS = ["harmonise-1.0.0"] as const;

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
  /** Spectral gain applied by this step, dB. Always 0 from harmonise-2.0.0. */
  gainDb?: number;
}

export interface HarmonizationRecord {
  version: string;
  target: typeof HARMONIZATION_TARGET;
  source: SourceMontage;
  steps: HarmonizationStep[];
  /** Total spectral gain applied across all steps, dB. 0 from harmonise-2.0.0. */
  totalGainDb: number;
  /** True only when the source reference is the target's bipolar frontal one. */
  referenceMatchesTarget: boolean;
  /** How much of the target band the source can actually support (0–1). */
  bandCoverage: number;
  /** Bands that must not be used from this source. */
  unusableBands: (keyof PhysionetBands)[];
  /** 0–1 confidence that the harmonised values are comparable to the target. */
  confidence: number;
  /** True: comparability is judged, not measured. */
  approximate: true;
  /** Anything the transform could not correct, stated plainly. */
  caveats: string[];
}

export interface HarmonizedEpoch extends PhysionetEpoch {
  harmonization: HarmonizationRecord;
  /** Bands the source passband supports; unavailable bands are absent, not 0. */
  availableBands: Partial<PhysionetBands>;
  /** Sum of available bands only. */
  availableTotalPower: number;
  /** True when one or more bands were unavailable. */
  totalPowerPartial: boolean;
}

/* ------------------------------------------------- reference correction --- */

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
  // Only an explicit average label means average. A generic "-REF" is the
  // amplifier's own reference, which is unknown without dataset metadata.
  if (/-(AVG|AVE|AVERAGE)$/.test(c)) return "average";
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

  const referenceMatchesTarget = source.reference === HARMONIZATION_TARGET.reference;
  steps.push({
    step: "reference-preserved",
    detail: `source reference ${source.reference} kept as recorded; re-referencing to ${HARMONIZATION_TARGET.reference} needs the other electrodes' signals and was not performed`,
    gainDb: 0,
  });
  if (source.reference === "unknown") {
    caveats.push("Reference scheme was not documented; it is treated as unknown.");
  } else if (!referenceMatchesTarget) {
    caveats.push(
      `Recorded against a ${source.reference} reference, not the target bipolar frontal derivation. Amplitudes and absolute powers are not comparable across references; no correction was applied.`,
    );
  }

  const lo = source.lowHz ?? HARMONIZATION_TARGET.lowHz;
  const hi = source.highHz ?? (source.sampleRateHz ? source.sampleRateHz / 2.5 : 45);
  steps.push({
    step: "band-limit",
    detail: `source passband ${lo}–${Math.round(hi)} Hz documented against the ${HARMONIZATION_TARGET.lowHz}–${HARMONIZATION_TARGET.highHz} Hz target; no filtering applied`,
  });

  if (source.sampleRateHz && source.sampleRateHz !== HARMONIZATION_TARGET.sampleRateHz) {
    steps.push({
      step: "spectral-regrid",
      detail: `${source.sampleRateHz} Hz native rate; spectra are on the 0.5 Hz DSA grid as imported`,
    });
  }

  const bad = unusableBands(source);
  if (bad.length) {
    caveats.push(
      `Source passband cannot support: ${bad.join(", ")} — these bands are unavailable (not zero) and the record is withheld from full-band fits.`,
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

  const confidence =
    Math.round(REFERENCE_CONFIDENCE[source.reference] * (0.5 + 0.5 * coverage) * 100) / 100;

  if (!source.channel) {
    caveats.push("Channel label absent; montage inferred from dataset defaults.");
  }

  return {
    version: HARMONIZATION_VERSION,
    target: HARMONIZATION_TARGET,
    source,
    steps,
    totalGainDb: 0,
    referenceMatchesTarget,
    bandCoverage: Math.round(coverage * 1000) / 1000,
    unusableBands: bad,
    confidence,
    approximate: true,
    caveats,
  };
}

/**
 * Attach the plan to one epoch. Nothing is rescaled: the spectrum, band
 * powers, SEF95 and suppression verdict are the source's own values. Bands
 * the source cannot support are left out of `availableBands` rather than
 * written as zero.
 */
export function harmonizeEpoch(
  epoch: PhysionetEpoch,
  source: SourceMontage,
  plan?: HarmonizationRecord,
): HarmonizedEpoch {
  const record = plan ?? planHarmonization(source);
  const availableBands: Partial<PhysionetBands> = {};
  let availableTotalPower = 0;
  for (const key of Object.keys(epoch.bands) as (keyof PhysionetBands)[]) {
    if (record.unusableBands.includes(key)) continue;
    availableBands[key] = epoch.bands[key];
    availableTotalPower += epoch.bands[key];
  }
  return {
    ...epoch,
    spectrumDb: [...epoch.spectrumDb],
    bands: { ...epoch.bands },
    availableBands,
    availableTotalPower,
    totalPowerPartial: record.unusableBands.length > 0,
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
  const unavailable = record.unusableBands?.length
    ? `, unavailable bands ${record.unusableBands.join("/")}`
    : "";
  return (
    `source reference ${record.source.reference} preserved; no re-referencing, ` +
    `coverage ${(record.bandCoverage * 100).toFixed(0)}%${unavailable}, ` +
    `confidence ${(record.confidence * 100).toFixed(0)}% (${record.version})`
  );
}

export interface FitCompatibility {
  compatible: boolean;
  reason: string | null;
}

/**
 * Whether a stored record may enter a NEW model fit. Fails closed: legacy
 * versions, any applied gain, an applied reference-normalisation step, or
 * missing bands the fit needs all make it incompatible. Stored rows are not
 * modified; they must be reprocessed from the original files.
 */
export function isHarmonizationFitCompatible(
  record: unknown,
  requiredBands: (keyof PhysionetBands)[] = ["delta", "theta", "alpha", "beta", "gamma"],
): FitCompatibility {
  if (!record || typeof record !== "object") {
    return { compatible: false, reason: "No harmonisation record — provenance unknown." };
  }
  const r = record as Partial<HarmonizationRecord>;
  if (!r.version || (LEGACY_HARMONIZATION_VERSIONS as readonly string[]).includes(r.version)) {
    return {
      compatible: false,
      reason: `Legacy transform ${r.version ?? "(unversioned)"} applied invented reference gains or zeroed bands; reprocess from the original files before fitting.`,
    };
  }
  if (r.version !== HARMONIZATION_VERSION) {
    return { compatible: false, reason: `Unrecognised transform version ${r.version}.` };
  }
  const gain = Number(r.totalGainDb);
  if (!Number.isFinite(gain) || gain !== 0) {
    return { compatible: false, reason: "Record carries a non-zero spectral gain." };
  }
  if ((r.steps ?? []).some((s) => s.step === "reference-normalisation" || (s.gainDb ?? 0) !== 0)) {
    return { compatible: false, reason: "Record applied a reference-normalisation gain." };
  }
  const missing = requiredBands.filter((b) => (r.unusableBands ?? []).includes(b));
  if (missing.length) {
    return {
      compatible: false,
      reason: `Bands ${missing.join(", ")} are unavailable from this source's passband.`,
    };
  }
  return { compatible: true, reason: null };
}
