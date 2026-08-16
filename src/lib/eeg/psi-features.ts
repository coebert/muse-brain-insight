/**
 * SedLine / PSI-inspired montage features.
 *
 * Masimo do not publish the Patient State Index algorithm, but the published
 * descriptions of it agree on what it looks at: bilateral (left/right)
 * coherence, anterior-posterior and interhemispheric power relationships,
 * frontal alpha ("alpha anteriorisation" under propofol), slow-wave power, and
 * band-independent adaptive features that keep working when total EEG power is
 * low. The Muse 2 is a frontal-only bilateral montage, so the anterior-
 * posterior part cannot be reproduced; the bilateral and spectral-shape parts
 * can, and they are what this module derives.
 *
 * These features are not a PSI clone. They are used as reliability and shape
 * evidence for the COEBIS correction: a frontal index computed from one
 * hemisphere's spectrum deserves less correction when the hemispheres
 * disagree, and a spectrum showing strong alpha plus slow-wave power is
 * evidence of an adequately anaesthetised brain regardless of the index value.
 */

export interface MontageFeatures {
  /** Pearson r between the left and right log spectra (-1..1), null if unpaired. */
  coherence: number | null;
  /** |L-R| / (L+R) of total power, 0-1. Null if unpaired. */
  asymmetry: number | null;
  /** Alpha (8-12 Hz) share of 0.5-30 Hz power, 0-1. */
  alphaFraction: number | null;
  /** Slow-wave (0.5-4 Hz) share of 0.5-30 Hz power, 0-1. */
  slowFraction: number | null;
}

export const EMPTY_MONTAGE: MontageFeatures = {
  coherence: null,
  asymmetry: null,
  alphaFraction: null,
  slowFraction: null,
};

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 4) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da <= 0 || db <= 0) return null;
  return num / Math.sqrt(da * db);
}

function bandShare(
  spectrum: number[],
  binHz: number,
  lo: number,
  hi: number,
  refLo: number,
  refHi: number,
): number | null {
  const lin = spectrum.map((db) => 10 ** (db / 10));
  const sum = (a: number, b: number) => {
    let s = 0;
    for (let k = Math.round(a / binHz); k <= Math.round(b / binHz) && k < lin.length; k++) {
      s += lin[k] ?? 0;
    }
    return s;
  };
  const ref = sum(refLo, refHi);
  if (!(ref > 0)) return null;
  return Math.min(1, Math.max(0, sum(lo, hi) / ref));
}

/**
 * Derive the montage features from the two hemispheric dB spectra of an epoch.
 * Either side may be missing; the bilateral features are then null.
 */
export function montageFeatures(
  left: number[] | null | undefined,
  right: number[] | null | undefined,
  binHz = 0.5,
): MontageFeatures {
  const combined = left && right
    ? left.map((v, i) => (v + (right[i] ?? v)) / 2)
    : (left ?? right ?? null);

  let coherence: number | null = null;
  let asymmetry: number | null = null;
  if (left?.length && right?.length) {
    coherence = pearson(left, right);
    const power = (s: number[]) => s.reduce((acc, db) => acc + 10 ** (db / 10), 0);
    const l = power(left);
    const r = power(right);
    asymmetry = l + r > 0 ? Math.abs(l - r) / (l + r) : null;
  }

  return {
    coherence,
    asymmetry,
    alphaFraction: combined ? bandShare(combined, binHz, 8, 12, 0.5, 30) : null,
    slowFraction: combined ? bandShare(combined, binHz, 0.5, 4, 0.5, 30) : null,
  };
}

/**
 * Montage features of the epoch currently on screen. The depth estimator runs
 * on a single mixed channel, so the bilateral evidence is published here by the
 * monitor and read back when COEBIS is finished.
 */
let active: MontageFeatures = EMPTY_MONTAGE;

export function setActiveMontageFeatures(features: MontageFeatures | null) {
  active = features ?? EMPTY_MONTAGE;
}

export function getActiveMontageFeatures(): MontageFeatures {
  return active;
}
