/**
 * DOSE-I published processed-EEG (`pEEG`) feature files.
 *
 * The Zenodo record ships the raw two-channel recordings in a 700 MB archive,
 * but it also publishes `pEEG.zip`: one CSV per recording holding the derived
 * spectral features at 1 Hz — absolute and relative band powers, median
 * frequency, SEF95 — alongside the contemporaneous MOAA/S sedation score,
 * state-of-consciousness flag and propofol dosing.
 *
 * That is exactly the shape this app stores per epoch, so the feature files are
 * ingested directly instead of re-deriving them from 78 hours of raw signal.
 *
 * Two things are assumed and recorded as caveats rather than hidden:
 *
 *   1. `abs_*` columns are published as log10 band power, so linear power is
 *      `10^v` and the DSA value in dB is `10·v`. Only the spectral *shape* is
 *      used downstream, which is invariant to the constant this assumption
 *      would get wrong.
 *   2. The collection publishes no burst-suppression annotation, so no epoch
 *      from it is marked suppressed; it contributes sedation-depth material
 *      only.
 */

import {
  DSA_FREQ_START_HZ,
  DSA_FREQ_STEP_HZ,
  type PhysionetEpoch,
} from "./physionet";
import { DOSE1_SOURCE } from "./sedation-icu";

/** DOSE-I band edges, Hz, in the order the CSV publishes them. */
export const DOSE1_BANDS: { key: string; lowHz: number; highHz: number }[] = [
  { key: "subdelta", lowHz: 0.1, highHz: 0.5 },
  { key: "delta1", lowHz: 0.5, highHz: 2 },
  { key: "delta2", lowHz: 2, highHz: 4 },
  { key: "theta", lowHz: 4, highHz: 8 },
  { key: "alpha", lowHz: 8, highHz: 13 },
  { key: "beta1", lowHz: 13, highHz: 20 },
  { key: "beta2", lowHz: 20, highHz: 30 },
  { key: "gamma", lowHz: 30, highHz: 45 },
];

const DSA_FREQ_END_HZ = 30;
const DSA_BINS = Math.round((DSA_FREQ_END_HZ - DSA_FREQ_START_HZ) / DSA_FREQ_STEP_HZ) + 1;

/** Analysis window the published features are computed over, seconds. */
export const DOSE1_EPOCH_SECONDS = 4;

function splitCsvLine(line: string): string[] {
  return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

const num = (v: string | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Seconds from an ISO-ish `YYYY-MM-DD HH:MM:SS` stamp, or null. */
function clockSeconds(v: string | undefined): number | null {
  if (!v) return null;
  const ms = Date.parse(v.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z"));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * MOAA/S → this app's shared state vocabulary. 5 is fully awake, 0 is
 * unresponsive to a painful stimulus.
 */
export function labelFromMoaas(moaas: number | null): string | null {
  if (moaas == null) return null;
  if (moaas >= 5) return "awake";
  if (moaas >= 3) return "sedated";
  return "anaesthetised";
}

export interface Dose1PeegOptions {
  caseRef: string;
  channel?: string | null;
}

export interface Dose1PeegFile {
  epochs: PhysionetEpoch[];
  /** Rows the file published but that carried no usable band powers. */
  skipped: number;
  /** Peak propofol dose seen in the file, mg, when annotated. */
  propofolMaxMg: number | null;
  moaasRange: { min: number; max: number } | null;
}

/**
 * Parse one `*_pEEG.csv` feature file into stored epochs. Rows missing the
 * absolute band powers (the leading seconds before the first full window) are
 * dropped rather than stored as silent zeros.
 */
export function parseDose1PeegCsv(text: string, options: Dose1PeegOptions): Dose1PeegFile {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("The pEEG file is empty.");
  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());

  const col = (name: string) => header.indexOf(name);
  const timeIdx = col("time");
  const sefIdx = col("sef95");
  const mfIdx = col("mf");
  const moaasIdx = col("moaas");
  const propofolIdx = col("propofol");

  const bandIdx = DOSE1_BANDS.map((b) => ({ ...b, idx: col(`abs_${b.key}`) }));
  if (bandIdx.some((b) => b.idx < 0)) {
    throw new Error("The pEEG file has no absolute band-power columns.");
  }

  const epochs: PhysionetEpoch[] = [];
  let skipped = 0;
  let propofolMax: number | null = null;
  let moaasMin: number | null = null;
  let moaasMax: number | null = null;
  let t0: number | null = null;

  lines.slice(1).forEach((line, r) => {
    const row = splitCsvLine(line);

    // Linear band power from published log10 values.
    const linear = bandIdx.map((b) => {
      const v = num(row[b.idx]);
      return v == null ? null : Math.pow(10, v);
    });
    // The narrow sub-delta band is often blank early on; require the rest.
    if (linear.slice(1).some((v) => v == null)) {
      skipped++;
      return;
    }

    const clock = timeIdx >= 0 ? clockSeconds(row[timeIdx]) : null;
    if (clock != null && t0 == null) t0 = clock;
    const atSeconds = clock != null && t0 != null ? clock - t0 : r;

    const powerOf = (lowHz: number, highHz: number) =>
      bandIdx.reduce((sum, b, i) => {
        const v = linear[i];
        if (v == null) return sum;
        const overlap = Math.min(b.highHz, highHz) - Math.max(b.lowHz, lowHz);
        if (overlap <= 0) return sum;
        return sum + v * (overlap / (b.highHz - b.lowHz));
      }, 0);

    const bands = {
      delta: powerOf(0.5, 4),
      theta: powerOf(4, 8),
      alpha: powerOf(8, 13),
      beta: powerOf(13, 30),
      gamma: powerOf(30, 45),
    };
    const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma;

    // Spread each band's power flat across its own width, then read the grid.
    const spectrumDb: number[] = [];
    for (let b = 0; b < DSA_BINS; b++) {
      const f = DSA_FREQ_START_HZ + b * DSA_FREQ_STEP_HZ;
      const hit = bandIdx.findIndex((band) => f >= band.lowHz && f < band.highHz);
      const power = hit >= 0 ? linear[hit] : null;
      const density = power == null ? 1e-6 : power / (bandIdx[hit]!.highHz - bandIdx[hit]!.lowHz);
      spectrumDb.push(Math.round(10 * Math.log10(Math.max(density, 1e-6)) * 100) / 100);
    }

    const sef = num(row[sefIdx]) ?? num(row[mfIdx]);
    const moaas = moaasIdx >= 0 ? num(row[moaasIdx]) : null;
    const propofol = propofolIdx >= 0 ? num(row[propofolIdx]) : null;
    if (propofol != null) propofolMax = Math.max(propofolMax ?? 0, propofol);
    if (moaas != null) {
      moaasMin = moaasMin == null ? moaas : Math.min(moaasMin, moaas);
      moaasMax = moaasMax == null ? moaas : Math.max(moaasMax, moaas);
    }

    const label = labelFromMoaas(moaas);
    epochs.push({
      caseRef: options.caseRef,
      channel: options.channel ?? null,
      atSeconds: Math.round(atSeconds * 1000) / 1000,
      epochSeconds: DOSE1_EPOCH_SECONDS,
      // Derived features; the raw rate lives in the separate raw archive.
      sampleRate: null,
      spectrumDb,
      bands,
      totalPower,
      sef95: sef != null && sef > 0 ? Math.round(sef * 100) / 100 : 0,
      // No burst-suppression annotation is published for this collection.
      suppressionRatio: 0,
      isSuppressed: false,
      label,
      labelSource: label ? "dataset" : "derived",
      externalRef: `${DOSE1_SOURCE}:${options.caseRef}:${atSeconds.toFixed(3)}`,
    });
  });

  if (!epochs.length) throw new Error("No rows in the pEEG file carried band powers.");

  return {
    epochs,
    skipped,
    propofolMaxMg: propofolMax,
    moaasRange: moaasMin != null && moaasMax != null ? { min: moaasMin, max: moaasMax } : null,
  };
}

/** File-level covariates recorded with every epoch of a DOSE-I recording. */
export function dose1Covariates(file: Dose1PeegFile): Record<string, string | number | null> {
  return {
    setting: "procedural_sedation",
    regimen: "propofol_only",
    procedure: "endoscopy",
    depth_label_source: "moaas",
    ...(file.propofolMaxMg != null ? { propofol_max_mg: file.propofolMaxMg } : {}),
    ...(file.moaasRange
      ? { moaas_min: file.moaasRange.min, moaas_max: file.moaasRange.max }
      : {}),
  };
}
