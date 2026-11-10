/**
 * Accessors for amplitude-dependent epoch measurements.
 *
 * On a band without a microvolt scale (`calibratedAmplitude: false`) the
 * analyser cannot apply its µV thresholds, so suppression and the seizure
 * score are withheld. The Epoch keeps numeric placeholders for backwards
 * compatibility; every display, export, digest and persistence path must read
 * the values through these helpers so a withheld value is `null` — never 0.
 */
import type { Epoch } from "@/lib/eeg/analysis";

type SuppressionFields = Pick<Epoch, "suppressionRatio" | "epochSuppression" | "isSuppressed"> & {
  suppressionAvailable?: boolean;
};
type SeizureFields = Pick<Epoch, "seizureScore" | "seizureAlert"> & {
  seizureAvailable?: boolean;
};

export const SUPPRESSION_WITHHELD_REASON =
  "Device amplitude scale is not calibrated; suppression was withheld, not measured as zero.";
export const SEIZURE_WITHHELD_REASON =
  "Device amplitude scale is not calibrated; the seizure score relies on fixed microvolt amplitude gates and was withheld.";

export function suppressionMeasured(e: { suppressionAvailable?: boolean } | null | undefined): boolean {
  return !!e && e.suppressionAvailable !== false;
}

export function seizureMeasured(e: { seizureAvailable?: boolean } | null | undefined): boolean {
  return !!e && e.seizureAvailable !== false;
}

/** Trailing-window suppression ratio (%), or null when withheld. */
export function measuredSuppressionRatio(e: SuppressionFields | null | undefined): number | null {
  if (!e || e.suppressionAvailable === false) return null;
  return Number.isFinite(e.suppressionRatio) ? e.suppressionRatio : null;
}

/** Fraction of this epoch that was isoelectric (0–1), or null when withheld. */
export function measuredEpochSuppression(e: SuppressionFields | null | undefined): number | null {
  if (!e || e.suppressionAvailable === false) return null;
  return Number.isFinite(e.epochSuppression) ? e.epochSuppression : null;
}

export function measuredIsSuppressed(e: SuppressionFields | null | undefined): boolean | null {
  if (!e || e.suppressionAvailable === false) return null;
  return e.isSuppressed;
}

/** Seizure likelihood (0–1), or null when withheld. */
export function measuredSeizureScore(e: SeizureFields | null | undefined): number | null {
  if (!e || e.seizureAvailable === false) return null;
  return Number.isFinite(e.seizureScore) ? e.seizureScore : null;
}

/** Values of `pick` over the epochs where it was measured (nulls dropped, never zero-filled). */
export function measuredValues<T>(rows: T[], pick: (row: T) => number | null): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = pick(r);
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  return out;
}
