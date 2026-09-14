/**
 * COEBIS-2 read on the Cambridge propofol (Chennu) epochs.
 *
 * The collection publishes what the volunteer was doing — awake, sedated and
 * still answering, sedated and not answering, recovered — not a monitor
 * number. So the index is not graded for agreement with anything here. It is
 * graded for the only thing those labels can support: does COEBIS read high
 * while the volunteer responds and low while they do not, on epochs it never
 * saw during fitting?
 *
 * Two honesty constraints are carried through every number below:
 *  - Chennu is a 91-channel high-density scalp montage. COEBIS-2 was fitted on
 *    a bedside frontal lineage, so this is an extrapolation, reported as one.
 *  - Nothing here promotes or alters a model. It is a read-out.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHENNU_LINEAGE } from "./chennu";
import { scoreStoredCase, type StoredSpectrum } from "./coebis-spectra";
import { COEBIS_V2_MODEL, coebisV2Applicability } from "./coebis-v2";
import {
  collapseState,
  separationFromScores,
  type Separation,
  type StateEpoch,
} from "./state-labels";

type Client = SupabaseClient<any, any, any>;

/** Ceiling on one read, so the request always finishes in its time slice. */
export const MAX_CHENNU_EPOCHS = 40_000;
const PAGE = 1000;

export interface ChennuLabelScore {
  label: string;
  epochs: number;
  meanIndex: number;
  minIndex: number;
  maxIndex: number;
  /** Share of epochs reading below 60, the usual "adequate anaesthesia" line. */
  belowSixty: number;
}

export interface ChennuCaseScore {
  caseRef: string;
  epochs: number;
  meanIndex: number;
  /** Average index while the volunteer was responding, and while not. */
  meanResponsive: number | null;
  meanUnresponsive: number | null;
}

export interface ChennuCoebisReport {
  lineage: string;
  modelLineage: string;
  applicability: "fitted" | "near" | "extrapolated";
  epochsScanned: number;
  epochsScored: number;
  cases: number;
  /** Epochs whose published label is neither clearly responsive nor not. */
  unusable: number;
  byLabel: ChennuLabelScore[];
  byCase: ChennuCaseScore[];
  separation: Separation;
  truncated: boolean;
}

interface Row {
  caseRef: string;
  channel: string | null;
  atSeconds: number;
  label: string;
  spectrumDb: number[] | null;
  freqStart: number;
  freqStep: number;
  suppressionPct: number | null;
}

async function loadChennuEpochs(
  supabase: Client,
  userId: string,
  limit: number,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  let truncated = false;
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("external_spectral_epochs")
      .select(
        "case_ref, channel, at_seconds, label, spectrum_db, freq_start_hz, freq_step_hz, suppression_ratio",
      )
      .eq("user_id", userId)
      .eq("source_lineage", CHENNU_LINEAGE)
      .not("label", "is", null)
      .order("case_ref", { ascending: true })
      .order("at_seconds", { ascending: true })
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of page) {
      rows.push({
        caseRef: String(r["case_ref"] ?? "?"),
        channel: r["channel"] == null ? null : String(r["channel"]),
        atSeconds: Number(r["at_seconds"] ?? 0),
        label: String(r["label"] ?? ""),
        spectrumDb: Array.isArray(r["spectrum_db"]) ? (r["spectrum_db"] as number[]) : null,
        freqStart: Number(r["freq_start_hz"] ?? 0),
        freqStep: Number(r["freq_step_hz"] ?? 0),
        suppressionPct: r["suppression_ratio"] == null ? null : Number(r["suppression_ratio"]),
      });
    }
    if (page.length < PAGE) return { rows, truncated };
    if (from + PAGE >= limit) truncated = true;
  }
  return { rows, truncated };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : 0);

/** Score every stored Chennu epoch with COEBIS-2 and grade it on the labels. */
export async function runChennuCoebis(
  supabase: Client,
  userId: string,
  limit = MAX_CHENNU_EPOCHS,
): Promise<ChennuCoebisReport> {
  const { rows, truncated } = await loadChennuEpochs(supabase, userId, limit);

  // One estimator run per case and channel: the trend memory and smoothing are
  // only meaningful along a single continuous recording.
  const tracks = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.caseRef}::${r.channel ?? "eeg"}`;
    const list = tracks.get(key);
    if (list) list.push(r);
    else tracks.set(key, [r]);
  }

  const points: StateEpoch[] = [];
  const scores: number[] = [];
  const byLabel = new Map<string, number[]>();
  const byCase = new Map<string, { all: number[]; resp: number[]; unresp: number[] }>();
  let scored = 0;
  let unusable = 0;

  for (const track of tracks.values()) {
    const epochs: StoredSpectrum[] = track.map((r) => ({
      atSeconds: r.atSeconds,
      spectrumDb: r.spectrumDb,
      freqStart: r.freqStart,
      freqStep: r.freqStep,
      suppressionPct: r.suppressionPct,
    }));
    const readings = scoreStoredCase(epochs);
    const byTime = new Map(readings.map((x) => [x.atSeconds, x.index]));

    for (const r of track) {
      const index = byTime.get(r.atSeconds);
      if (index == null) continue;
      scored++;

      const labelList = byLabel.get(r.label) ?? [];
      labelList.push(index);
      byLabel.set(r.label, labelList);

      const caseEntry = byCase.get(r.caseRef) ?? { all: [], resp: [], unresp: [] };
      caseEntry.all.push(index);

      const state = collapseState(r.label);
      if (!state) {
        unusable++;
      } else {
        if (state === "responsive") caseEntry.resp.push(index);
        else caseEntry.unresp.push(index);
        points.push({
          caseRef: r.caseRef,
          atSeconds: r.atSeconds,
          label: r.label,
          state,
          features: {
            logBetaDelta: 0,
            relDelta: 0,
            relAlpha: 0,
            relBeta: 0,
            sef: 0,
            suppression: 0,
          },
        });
        scores.push(index);
      }
      byCase.set(r.caseRef, caseEntry);
    }
  }

  return {
    lineage: CHENNU_LINEAGE,
    modelLineage: COEBIS_V2_MODEL.meta.lineage,
    applicability: coebisV2Applicability(CHENNU_LINEAGE, 250, null),
    epochsScanned: rows.length,
    epochsScored: scored,
    cases: byCase.size,
    unusable,
    byLabel: [...byLabel.entries()]
      .map(([label, xs]) => ({
        label,
        epochs: xs.length,
        meanIndex: Number(mean(xs).toFixed(1)),
        minIndex: Math.min(...xs),
        maxIndex: Math.max(...xs),
        belowSixty: xs.filter((v) => v < 60).length / xs.length,
      }))
      .sort((a, b) => b.epochs - a.epochs),
    byCase: [...byCase.entries()]
      .map(([caseRef, v]) => ({
        caseRef,
        epochs: v.all.length,
        meanIndex: Number(mean(v.all).toFixed(1)),
        meanResponsive: v.resp.length ? Number(mean(v.resp).toFixed(1)) : null,
        meanUnresponsive: v.unresp.length ? Number(mean(v.unresp).toFixed(1)) : null,
      }))
      .sort((a, b) => a.caseRef.localeCompare(b.caseRef)),
    separation: separationFromScores(points, scores),
    truncated,
  };
}
