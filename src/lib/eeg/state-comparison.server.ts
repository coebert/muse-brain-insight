/**
 * Simple state models against COEBIS, on exactly the same epochs.
 *
 * Two things are being compared and they are not the same kind of thing:
 *
 *  - COEBIS reads each epoch with coefficients fitted elsewhere, on surgical
 *    BIS. It never saw these volunteers, so its number here is honestly
 *    out-of-sample — but it is also being read on a montage it was not fitted
 *    to, which is an extrapolation.
 *  - The small models are fitted *on these very recordings*, with whole-case
 *    folds so no volunteer is scored by a model that saw them.
 *
 * The comparison is therefore generous to the small models by construction:
 * they are tuned to this population, COEBIS is not. That asymmetry is stated
 * in the read-out rather than buried, because the interesting result is if a
 * one-descriptor rule tuned to the data still fails to beat an untuned index.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHENNU_LINEAGE } from "./chennu";
import { scoreStoredCase, type StoredSpectrum } from "./coebis-spectra";
import { DOSE1_LINEAGE } from "./sedation-icu";
import {
  BASELINE_STATE_MODEL,
  collapseState,
  featuresFrom,
  scoreState,
  separationFromScores,
  separationOf,
  caseFolds,
  fitStateModel,
  type Separation,
  type StateEpoch,
} from "./state-labels";
import { gradeSimpleModels, type SimpleModelGrade } from "./simple-state-model";

type Client = SupabaseClient<any, any, any>;

/** The two collections whose labels describe a person, not a monitor. */
export const SEDATION_LINEAGES = [CHENNU_LINEAGE, DOSE1_LINEAGE];

/** Ceiling on one read, so the request finishes inside its time slice. */
export const MAX_COMPARISON_EPOCHS = 40_000;
const PAGE = 1000;

export interface StateComparisonReport {
  lineages: string[];
  epochs: number;
  cases: number;
  responsive: number;
  unresponsive: number;
  folds: number;
  /** COEBIS read on these epochs — not fitted to them. */
  coebis: Separation;
  /** The documented reference mapping, also unfitted. */
  reference: Separation;
  /** The six-descriptor logistic fit, whole-case held out. */
  full: Separation;
  /** Every small candidate, best separation first. */
  simple: SimpleModelGrade[];
  /** Per collection, so one dataset cannot carry the other. */
  byLineage: {
    lineage: string;
    epochs: number;
    cases: number;
    coebisAuc: number;
    bestSimpleKey: string | null;
    bestSimpleAuc: number | null;
  }[];
  truncated: boolean;
}

export interface SedationRow {
  lineage: string;
  caseRef: string;
  channel: string | null;
  atSeconds: number;
  label: string;
  bands: Record<string, unknown>;
  sef95: number | null;
  suppressionPct: number | null;
  spectrumDb: number[] | null;
  freqStart: number;
  freqStep: number;
}

/** Every labelled epoch of the sedation collections, oldest first per track. */
export async function loadSedationRows(
  supabase: Client,
  userId: string,
  limit: number,
): Promise<{ rows: SedationRow[]; truncated: boolean }> {
  const rows: SedationRow[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("external_spectral_epochs")
      .select(
        "source_lineage, case_ref, channel, at_seconds, label, bands, sef95, suppression_ratio, spectrum_db, freq_start_hz, freq_step_hz",
      )
      .eq("user_id", userId)
      .in("source_lineage", SEDATION_LINEAGES)
      .not("label", "is", null)
      .order("source_lineage", { ascending: true })
      .order("case_ref", { ascending: true })
      .order("at_seconds", { ascending: true })
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of page) {
      rows.push({
        lineage: String(r["source_lineage"] ?? "?"),
        caseRef: String(r["case_ref"] ?? "?"),
        channel: r["channel"] == null ? null : String(r["channel"]),
        atSeconds: Number(r["at_seconds"] ?? 0),
        label: String(r["label"] ?? ""),
        bands: (r["bands"] ?? {}) as Record<string, unknown>,
        sef95: r["sef95"] == null ? null : Number(r["sef95"]),
        suppressionPct: r["suppression_ratio"] == null ? null : Number(r["suppression_ratio"]),
        spectrumDb: Array.isArray(r["spectrum_db"]) ? (r["spectrum_db"] as number[]) : null,
        freqStart: Number(r["freq_start_hz"] ?? 0),
        freqStep: Number(r["freq_step_hz"] ?? 0),
      });
    }
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Grade COEBIS and the small models on one shared pool of labelled epochs. */
export async function compareStateModels(
  supabase: Client,
  userId: string,
  limit = MAX_COMPARISON_EPOCHS,
): Promise<StateComparisonReport> {
  const { rows, truncated } = await loadSedationRows(supabase, userId, limit);

  // COEBIS is stateful along a recording, so score each track in time order.
  const tracks = new Map<string, SedationRow[]>();
  for (const r of rows) {
    const key = `${r.lineage}::${r.caseRef}::${r.channel ?? "eeg"}`;
    const list = tracks.get(key);
    if (list) list.push(r);
    else tracks.set(key, [r]);
  }

  const points: StateEpoch[] = [];
  const coebisScores: number[] = [];
  const lineageOf: string[] = [];

  for (const track of tracks.values()) {
    const spectra: StoredSpectrum[] = track.map((r) => ({
      atSeconds: r.atSeconds,
      spectrumDb: r.spectrumDb,
      freqStart: r.freqStart,
      freqStep: r.freqStep,
      suppressionPct: r.suppressionPct,
    }));
    const readings = scoreStoredCase(spectra);
    const byTime = new Map(readings.map((x) => [x.atSeconds, x.index]));

    for (const r of track) {
      const state = collapseState(r.label);
      const coebis = byTime.get(r.atSeconds);
      // Only epochs both models can read, so the comparison stays like for like.
      if (!state || coebis == null) continue;
      const numberOf = (k: string) => Number(r.bands[k] ?? 0) || 0;
      points.push({
        caseRef: `${r.lineage}/${r.caseRef}`,
        atSeconds: r.atSeconds,
        label: r.label,
        state,
        features: featuresFrom(
          {
            delta: numberOf("delta"),
            theta: numberOf("theta"),
            alpha: numberOf("alpha"),
            beta: numberOf("beta"),
            gamma: numberOf("gamma"),
          },
          r.sef95,
          r.suppressionPct,
        ),
      });
      coebisScores.push(coebis);
      lineageOf.push(r.lineage);
    }
  }

  const folds = caseFolds(points);
  const fullHeldOut: { point: StateEpoch; score: number }[] = [];
  for (let i = 0; i < folds.length; i++) {
    const test = folds[i]!;
    const train = folds.filter((_, j) => j !== i).flat();
    const model = fitStateModel(train);
    if (!model) continue;
    for (const p of test) fullHeldOut.push({ point: p, score: scoreState(model, p.features) });
  }

  const simple = gradeSimpleModels(points);

  const byLineage = SEDATION_LINEAGES.map((lineage) => {
    const idx = lineageOf.flatMap((l, i) => (l === lineage ? [i] : []));
    const subsetPoints = idx.map((i) => points[i]!);
    const subsetScores = idx.map((i) => coebisScores[i]!);
    const subsetSimple = subsetPoints.length >= 200 ? gradeSimpleModels(subsetPoints) : [];
    return {
      lineage,
      epochs: subsetPoints.length,
      cases: new Set(subsetPoints.map((p) => p.caseRef)).size,
      coebisAuc: Number(separationFromScores(subsetPoints, subsetScores).auc.toFixed(3)),
      bestSimpleKey: subsetSimple[0]?.key ?? null,
      bestSimpleAuc:
        subsetSimple[0] == null ? null : Number(subsetSimple[0].separation.auc.toFixed(3)),
    };
  }).filter((l) => l.epochs > 0);

  return {
    lineages: SEDATION_LINEAGES,
    epochs: points.length,
    cases: new Set(points.map((p) => p.caseRef)).size,
    responsive: points.filter((p) => p.state === "responsive").length,
    unresponsive: points.filter((p) => p.state === "unresponsive").length,
    folds: folds.length,
    coebis: separationFromScores(points, coebisScores),
    reference: separationOf(points, (f) => scoreState(BASELINE_STATE_MODEL, f)),
    full: fullHeldOut.length
      ? separationFromScores(
          fullHeldOut.map((h) => h.point),
          fullHeldOut.map((h) => h.score),
        )
      : separationFromScores([], []),
    simple,
    byLineage,
    truncated,
  };
}
