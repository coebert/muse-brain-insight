/**
 * Tune the COEBIS scale to the Chennu and DOSE-I sedation labels.
 *
 * The fit is a monotone output curve (see `coebis-sedation-bands.ts`), graded
 * with whole-case folds, and it is only adopted if two things hold at once:
 * band placement clearly improves on cases the curve never saw, *and* the
 * curve costs no meaningful accuracy against the real bedside BIS readings
 * already stored. The second test is exact rather than estimated — the curve
 * acts on the index alone, so it can be replayed over every stored paired
 * reading without re-deriving anything.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  applyTune,
  bandFolds,
  bandOfLabel,
  fitSedationTune,
  gradeBands,
  IDENTITY_TUNE,
  KNOTS,
  MAX_BIS_MAE_COST,
  MIN_IN_BAND_GAIN,
  type BandGrade,
  type BandPoint,
  type SedationTune,
} from "./coebis-sedation-bands";
import { scoreStoredCase, type StoredSpectrum } from "./coebis-spectra";
import { loadSedationRows, SEDATION_LINEAGES, type SedationRow } from "./state-comparison.server";

type Client = SupabaseClient<any, any, any>;

export const SEDATION_TUNE_LINEAGE = "coebis:sedation-bands";
export const SEDATION_TUNE_FAMILY = "coebis_v2_sedation_bands";
export const MAX_TUNE_EPOCHS = 40_000;

export interface BisGuard {
  points: number;
  maeBefore: number;
  maeAfter: number;
  /** Positive means the curve costs accuracy against the bedside monitor. */
  cost: number;
}

export interface SedationTuneReport {
  lineages: string[];
  epochs: number;
  cases: number;
  folds: number;
  tune: SedationTune;
  knots: number[];
  /** Held-out band placement: every case scored by a curve fitted without it. */
  heldOut: BandGrade[];
  /** In-sample placement, for reference only. */
  inSample: BandGrade[];
  inBandBefore: number;
  inBandAfter: number;
  bis: BisGuard | null;
  promoted: boolean;
  reason: string;
  truncated: boolean;
}

function pointsFrom(rows: SedationRow[]): BandPoint[] {
  const tracks = new Map<string, SedationRow[]>();
  for (const r of rows) {
    // Block included: the Cambridge blocks each restart at zero, so keying on
    // the case alone interleaves four drug levels into one nonsense track.
    const key = `${r.lineage}::${r.caseRef}::${r.channel ?? "eeg"}::${r.block ?? "-"}`;
    const list = tracks.get(key);
    if (list) list.push(r);
    else tracks.set(key, [r]);
  }

  const points: BandPoint[] = [];
  for (const track of tracks.values()) {
    const spectra: StoredSpectrum[] = track.map((r) => ({
      atSeconds: r.atSeconds,
      spectrumDb: r.spectrumDb,
      freqStart: r.freqStart,
      freqStep: r.freqStep,
      suppressionPct: r.suppressionPct,
    }));
    const byTime = new Map(scoreStoredCase(spectra).map((x) => [x.atSeconds, x.index]));
    for (const r of track) {
      const band = bandOfLabel(r.label);
      const index = byTime.get(r.atSeconds);
      if (!band || index == null) continue;
      points.push({ index, band, caseRef: `${r.lineage}/${r.caseRef}` });
    }
  }
  return points;
}

/** Replay the curve over stored bedside BIS pairs; nothing is re-derived. */
async function bisGuard(
  supabase: Client,
  userId: string,
  tune: SedationTune,
): Promise<BisGuard | null> {
  // Paged: the data API caps a single read, and a short read would flatter
  // the guard by judging the curve on a fraction of the bedside evidence.
  const pairs: { bis: number; index: number }[] = [];
  const PAGE = 1000;
  for (let from = 0; from < 20000; from += PAGE) {
    const { data, error } = await supabase
      .from("bis_paired_points")
      .select("bis, app_index")
      .eq("user_id", userId)
      .eq("reliable", true)
      .order("recorded_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as any[];
    for (const r of page) {
      const bis = Number(r.bis);
      const index = Number(r.app_index);
      if (Number.isFinite(bis) && Number.isFinite(index)) pairs.push({ bis, index });
    }
    if (page.length < PAGE) break;
  }
  if (pairs.length < 20) return null;

  const mae = (f: (x: number) => number) =>
    pairs.reduce((a, p) => a + Math.abs(f(p.index) - p.bis), 0) / pairs.length;
  const before = mae((x) => x);
  const after = mae((x) => applyTune(tune, x));
  return { points: pairs.length, maeBefore: before, maeAfter: after, cost: after - before };
}

export async function runSedationTune(
  supabase: Client,
  userId: string,
  admin: Client,
  limit = MAX_TUNE_EPOCHS,
): Promise<SedationTuneReport> {
  const { rows, truncated } = await loadSedationRows(supabase, userId, limit);
  const points = pointsFrom(rows);
  const cases = new Set(points.map((p) => p.caseRef)).size;

  const empty = (reason: string): SedationTuneReport => ({
    lineages: SEDATION_LINEAGES,
    epochs: points.length,
    cases,
    folds: 0,
    tune: IDENTITY_TUNE,
    knots: KNOTS,
    heldOut: gradeBands(points, IDENTITY_TUNE),
    inSample: gradeBands(points, IDENTITY_TUNE),
    inBandBefore: 0,
    inBandAfter: 0,
    bis: null,
    promoted: false,
    reason,
    truncated,
  });

  const folds = bandFolds(points);
  if (folds.length < 2) return empty("Not enough labelled cases to hold any out.");

  // Held-out placement: each fold remapped by a curve fitted without it.
  const heldOutPairs: { point: BandPoint; after: number }[] = [];
  for (let i = 0; i < folds.length; i++) {
    const test = folds[i]!;
    const train = folds.filter((_, j) => j !== i).flat();
    const fold = fitSedationTune(train);
    if (!fold) continue;
    for (const p of test) heldOutPairs.push({ point: p, after: applyTune(fold, p.index) });
  }
  if (!heldOutPairs.length) return empty("No fold produced a usable curve.");

  const full = fitSedationTune(points);
  if (!full) return empty("The curve did not fit on this pool.");

  // Grade the held-out remap by substituting each point's held-out value.
  const heldOutPoints: BandPoint[] = heldOutPairs.map(({ point, after }) => ({
    ...point,
    index: after,
  }));
  const beforeGrade = gradeBands(
    heldOutPairs.map(({ point }) => point),
    IDENTITY_TUNE,
  );
  const heldOutGrade = gradeBands(heldOutPoints, IDENTITY_TUNE).map((g, i) => ({
    ...g,
    meanBefore: beforeGrade[i]!.meanBefore,
    inBandBefore: beforeGrade[i]!.inBandBefore,
  }));

  const share = (list: BandGrade[], key: "inBandBefore" | "inBandAfter") => {
    const total = list.reduce((a, g) => a + g.epochs, 0);
    return total ? list.reduce((a, g) => a + g[key] * g.epochs, 0) / total : 0;
  };
  const inBandBefore = share(heldOutGrade, "inBandBefore");
  const inBandAfter = share(heldOutGrade, "inBandAfter");

  const bis = await bisGuard(supabase, userId, full);

  const gain = inBandAfter - inBandBefore;
  let reason = "";
  let promoted = false;
  if (gain < MIN_IN_BAND_GAIN) {
    reason = `Held-out band placement improved by only ${(gain * 100).toFixed(1)} points, below the ${(MIN_IN_BAND_GAIN * 100).toFixed(0)}-point bar.`;
  } else if (bis && bis.cost > MAX_BIS_MAE_COST) {
    reason = `Placement improved, but the curve costs ${bis.cost.toFixed(2)} points of agreement with the bedside monitor, above the ${MAX_BIS_MAE_COST}-point ceiling.`;
  } else {
    promoted = true;
    reason = bis
      ? `Held-out band placement improved by ${(gain * 100).toFixed(1)} points at a monitor-agreement cost of ${bis.cost.toFixed(2)}.`
      : `Held-out band placement improved by ${(gain * 100).toFixed(1)} points; no stored bedside pairs to check against.`;
  }

  if (promoted) await promote(admin, userId, full, points.length, cases, gain, bis, reason);

  return {
    lineages: SEDATION_LINEAGES,
    epochs: points.length,
    cases,
    folds: folds.length,
    tune: full,
    knots: KNOTS,
    heldOut: heldOutGrade,
    inSample: gradeBands(points, full),
    inBandBefore,
    inBandAfter,
    bis,
    promoted,
    reason,
    truncated,
  };
}

async function promote(
  admin: Client,
  userId: string,
  tune: SedationTune,
  epochs: number,
  cases: number,
  gain: number,
  bis: BisGuard | null,
  reason: string,
): Promise<void> {
  const { data } = await admin
    .from("coebis_model_versions")
    .select("version")
    .eq("user_id", userId)
    .eq("lineage_key", SEDATION_TUNE_LINEAGE)
    .order("version", { ascending: false })
    .limit(1);
  const version = Number((data?.[0] as any)?.version ?? 0) + 1;

  await admin
    .from("coebis_model_versions")
    .update({ is_active: false })
    .eq("user_id", userId)
    .eq("lineage_key", SEDATION_TUNE_LINEAGE);

  await admin.from("coebis_model_versions").insert({
    user_id: userId,
    lineage_key: SEDATION_TUNE_LINEAGE,
    version,
    model_family: SEDATION_TUNE_FAMILY,
    coefficients: { knots: KNOTS, outputs: tune.outputs },
    training: { epochs, cases, lineages: SEDATION_LINEAGES },
    metrics_before: { inBand: null, bisMae: bis?.maeBefore ?? null },
    metrics_after: { inBandGain: gain, bisMae: bis?.maeAfter ?? null },
    mae_gain: bis ? -(bis.cost) : null,
    promoted: true,
    is_active: true,
    reason,
    data_digest: `${epochs}:${cases}:${tune.outputs.map((o) => o.toFixed(2)).join(",")}`,
  });
}

/** The curve currently in force, or null when nothing has been adopted. */
export async function loadActiveSedationTune(
  supabase: Client,
  userId: string,
): Promise<SedationTune | null> {
  const { data, error } = await supabase
    .from("coebis_model_versions")
    .select("coefficients")
    .eq("user_id", userId)
    .eq("lineage_key", SEDATION_TUNE_LINEAGE)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1);
  if (error) return null;
  const outputs = (data?.[0] as any)?.coefficients?.outputs;
  if (!Array.isArray(outputs) || outputs.length !== KNOTS.length) return null;
  return { outputs: outputs.map((v: unknown) => Number(v)) };
}
