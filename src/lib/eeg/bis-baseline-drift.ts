/**
 * Per-patient baseline drift for the paired-reading timeline.
 *
 * The paired series pools readings from many cases, so a single pooled
 * baseline would be meaningless. Each case (sessionId) gets its own baseline —
 * the median of its first few COEBIS values — and every later reading in that
 * case is expressed as points of drift from it.
 */

import type { BisDriftSeriesPoint } from "@/lib/eeg/bis-drift.functions";

/** Readings used to anchor a per-case baseline. */
export const CASE_BASELINE_POINTS = 3;

export interface BaselineDriftPoint {
  /** Position in the pooled series, matching BisDriftSeriesPoint.i. */
  i: number;
  /** Case this reading belongs to ("—" when unattributed). */
  sessionId: string;
  /** Baseline COEBIS for that case, or null while it is still being anchored. */
  baseline: number | null;
  /** COEBIS − baseline, or null when either side is missing. */
  drift: number | null;
  /** True for the first reading of a new case in the pooled order. */
  caseStart: boolean;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

const value = (p: BisDriftSeriesPoint): number | null =>
  p.corrected != null && Number.isFinite(p.corrected) ? p.corrected : Number.isFinite(p.raw) ? p.raw : null;

/** Per-case baseline drift for each paired reading, in pooled order. */
export function baselineDriftSeries(series: BisDriftSeriesPoint[]): BaselineDriftPoint[] {
  const byCase = new Map<string, number[]>();
  for (const p of series) {
    const key = p.sessionId ?? "—";
    const v = value(p);
    if (v == null) continue;
    const list = byCase.get(key) ?? [];
    if (list.length < CASE_BASELINE_POINTS) list.push(v);
    byCase.set(key, list);
  }
  const baselines = new Map<string, number | null>();
  for (const [key, list] of byCase) baselines.set(key, list.length ? median(list) : null);

  let previous: string | null = null;
  return series.map((p) => {
    const key = p.sessionId ?? "—";
    const baseline = baselines.get(key) ?? null;
    const v = value(p);
    const point: BaselineDriftPoint = {
      i: p.i,
      sessionId: key,
      baseline,
      drift: baseline != null && v != null ? Number((v - baseline).toFixed(1)) : null,
      caseStart: previous != null && previous !== key,
    };
    previous = key;
    return point;
  });
}
