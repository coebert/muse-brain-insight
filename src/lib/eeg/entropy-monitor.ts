/**
 * Entropy-monitor style spectral entropies (GE M-Entropy / Datex-Ohmeda S/5).
 *
 * The published description of the commercial Entropy module (Viertiö-Oja et
 * al., Acta Anaesthesiol Scand 2004;48:154-61) differs from a plain Shannon
 * entropy of one PSD in three ways that matter clinically, all reproduced
 * here:
 *
 *  1. **Time-frequency balanced windows.** Each frequency component is
 *     averaged over a window chosen for that frequency — around 60 s at the
 *     slowest EEG frequencies, shortening to ~15 s in the EEG band and ~2 s
 *     for the 32-47 Hz EMG band. Slow rhythms are therefore stable while the
 *     EMG band stays fast-reacting.
 *  2. **Two bands.** State Entropy (SE) uses 0.8-32 Hz (EEG dominant) and is
 *     displayed 0-91; Response Entropy (RE) extends to 47 Hz, includes frontal
 *     EMG, is displayed 0-100, and equals SE when no EMG is present.
 *  3. **Burst suppression is folded in.** Suppressed epochs contribute zero
 *     entropy, so both numbers fall towards 0 as the suppression ratio rises
 *     rather than sitting on the entropy of the burst alone.
 *
 * The RE-SE difference is the monitor's EMG/arousal signal, and is the single
 * most useful extra input COEBIS gains from this family of algorithms: frontal
 * EMG is known to inflate commercial BIS, so the gap explains part of the
 * residual between COEBIS and a BIS monitor.
 */

/** Displayed ceiling of State Entropy on a commercial monitor. */
export const SE_MAX = 91;
/** Displayed ceiling of Response Entropy. */
export const RE_MAX = 100;

const SE_LO = 0.8;
const SE_HI = 32;
const RE_HI = 47;

export interface MonitorEntropy {
  /** State Entropy, 0-91. Null when there is no usable spectrum. */
  se: number | null;
  /** Response Entropy, 0-100. Never below SE. */
  re: number | null;
  /** RE - SE: frontal EMG / arousal margin in index points. */
  emgGap: number | null;
  /** Suppression ratio the entropies were scaled by (%). */
  bsr: number;
}

/**
 * Averaging window for a frequency component, in seconds. Long at the slow
 * end for stability, short at the EMG end for responsiveness — the balance the
 * commercial module strikes.
 */
export function entropyWindowSeconds(hz: number): number {
  if (hz < 2) return 60;
  if (hz < 8) return 30;
  if (hz <= 32) return 15;
  return 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Per-bin power averaged over the window appropriate to that bin's frequency.
 * `rows` is oldest-first; nulls (rejected epochs) are skipped.
 */
function balancedSpectrum(
  rows: (Float64Array | null)[],
  binHz: number,
  epochSeconds: number,
  maxBin: number,
): number[] {
  const out: number[] = [];
  for (let k = 0; k <= maxBin; k++) {
    const hz = k * binHz;
    const span = Math.max(1, Math.round(entropyWindowSeconds(hz) / Math.max(epochSeconds, 0.1)));
    const slice = rows.slice(-span);
    let sum = 0;
    let n = 0;
    for (const row of slice) {
      const v = row?.[k];
      if (v != null && Number.isFinite(v) && v > 0) {
        sum += v;
        n++;
      }
    }
    out[k] = n ? sum / n : 0;
  }
  return out;
}

/** Normalised Shannon entropy (0-1) of a power spectrum over [lo, hi] Hz. */
function normalisedEntropy(power: number[], binHz: number, lo: number, hi: number): number | null {
  const a = Math.max(1, Math.round(lo / binHz));
  const b = Math.round(hi / binHz);
  let total = 0;
  let bins = 0;
  for (let k = a; k <= b && k < power.length; k++) {
    total += power[k] ?? 0;
    bins++;
  }
  if (!(total > 0) || bins < 2) return null;
  let h = 0;
  for (let k = a; k <= b && k < power.length; k++) {
    const p = (power[k] ?? 0) / total;
    if (p > 0) h -= p * Math.log(p);
  }
  return clamp(h / Math.log(bins), 0, 1);
}

/**
 * State and Response Entropy from the rolling PSD history used by the depth
 * estimator.
 *
 * @param rows oldest-first PSD rows on a fixed `binHz` grid (nulls allowed)
 * @param bsr suppression ratio over the trailing window, 0-100 %
 * @param binHz spectral resolution of the rows
 * @param epochSeconds hop between rows
 */
export function monitorEntropy(
  rows: (Float64Array | null)[],
  bsr: number,
  binHz = 0.5,
  epochSeconds = 1,
): MonitorEntropy {
  const safeBsr = clamp(Number.isFinite(bsr) ? bsr : 0, 0, 100);
  const usable = rows.filter((r) => r != null).length;
  if (!usable) return { se: null, re: null, emgGap: null, bsr: safeBsr };

  const maxBin = Math.round(RE_HI / binHz);
  const power = balancedSpectrum(rows, binHz, epochSeconds, maxBin);

  const se01 = normalisedEntropy(power, binHz, SE_LO, SE_HI);
  const re01 = normalisedEntropy(power, binHz, SE_LO, RE_HI);
  if (se01 == null || re01 == null) return { se: null, re: null, emgGap: null, bsr: safeBsr };

  // Suppression contributes zero entropy: both numbers fall with BSR.
  const awakeFraction = 1 - safeBsr / 100;
  const se = clamp(SE_MAX * se01 * awakeFraction, 0, SE_MAX);

  // How much of the 32-47 Hz band is actually carrying power. With no EMG the
  // monitor reports RE = SE, so scale the extension by that occupancy.
  const bandPower = (lo: number, hi: number) => {
    let s = 0;
    for (let k = Math.round(lo / binHz); k <= Math.round(hi / binHz) && k < power.length; k++) {
      s += power[k] ?? 0;
    }
    return s;
  };
  const emgPower = bandPower(SE_HI, RE_HI);
  const totalPower = bandPower(SE_LO, RE_HI);
  const emgFraction = totalPower > 0 ? emgPower / totalPower : 0;
  const emgWeight = clamp((emgFraction - 0.02) / 0.18, 0, 1);

  const reFull = clamp(RE_MAX * re01 * awakeFraction, 0, RE_MAX);
  const re = clamp(se + emgWeight * Math.max(0, reFull - se), se, RE_MAX);

  return {
    se: Number(se.toFixed(1)),
    re: Number(re.toFixed(1)),
    emgGap: Number((re - se).toFixed(1)),
    bsr: safeBsr,
  };
}
