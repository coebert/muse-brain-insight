/**
 * COEBIS with the recorded agents' EEG signatures subtracted, for grading.
 *
 * The bedside path applies this correction inside the depth engine. Grading a
 * stored epoch has to reproduce it from what the row kept — the case's recorded
 * regimen and the epoch's band powers — so the drug-corrected score can be put
 * against the published indices on exactly the same epochs as the raw index.
 *
 * Two rules keep the comparison honest:
 *  - the agents come from the record (regimen, effect-site entry, note), never
 *    from the EEG, so the correction cannot be fitted to the label; and
 *  - an epoch with no recorded agent, no band powers, or heavy suppression is
 *    returned unchanged rather than imputed, so the corrected column is graded
 *    on the same rows as COEBIS, not an easier subset.
 */

import { drugStage, type DrugKey } from "./drug-signatures";
import { featuresFromBands } from "./ketamine-cases";

export interface DrugCorrectionInput {
  /** The index as scored, before any drug subtraction. */
  coebis: number | null;
  /** Stored band powers for this epoch (delta/theta/alpha/beta/gamma). */
  bands: Record<string, unknown> | null;
  /** Agents recorded for the case. */
  declared: DrugKey[];
  /** Suppression ratio for this epoch, percent. */
  suppressionPct: number | null;
  /** 0–1 signal quality, when the row carries one. */
  quality?: number | null;
}

export interface DrugCorrection {
  /** The index after correction; equal to `coebis` when nothing applied. */
  index: number | null;
  /** Points applied (negative = pulled deeper). Zero when nothing applied. */
  delta: number;
  /** Agents that actually moved the number. */
  applied: DrugKey[];
}

export const NO_CORRECTION: DrugCorrection = { index: null, delta: 0, applied: [] };

/** Reproduce the drug-signature stage for one stored epoch. */
export function drugCorrectedIndex({
  coebis,
  bands,
  declared,
  suppressionPct,
  quality,
}: DrugCorrectionInput): DrugCorrection {
  if (coebis == null || !Number.isFinite(coebis)) return { ...NO_CORRECTION };
  if (!declared.length) return { index: coebis, delta: 0, applied: [] };
  const features = featuresFromBands(bands);
  const stage = drugStage({
    aligned: coebis,
    features,
    declared,
    bsr: suppressionPct ?? 0,
    quality: quality ?? null,
  });
  const applied = stage.entries.filter((e) => e.delta !== 0).map((e) => e.key);
  const index = Number(Math.min(100, Math.max(0, coebis + stage.delta)).toFixed(2));
  return { index, delta: Number((index - coebis).toFixed(2)), applied };
}
