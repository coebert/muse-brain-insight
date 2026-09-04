/**
 * Server side of the reference library: how much of each label format the
 * pooled data already holds, and how an uploaded file is attached to one of
 * the user's own recordings.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { formatById, type ReferenceRow } from "./reference-library";

type Client = SupabaseClient<any, any, any>;

export interface FormatCoverage {
  formatId: string;
  /** Reference rows on file in this format. */
  rows: number;
  /** Distinct cases those rows cover. */
  cases: number;
  /** Whether the rows came from the user's own uploads rather than a dataset. */
  own: boolean;
}

export interface ReferenceLibraryReport {
  coverage: FormatCoverage[];
  /** Recordings an uploaded file can be attached to. */
  sessions: { id: string; caseCode: string | null; startedAt: string; durationSeconds: number; scoredEpochs: number }[];
  generatedAt: string;
}

export async function loadReferenceLibrary(
  supabase: Client,
  userId: string,
): Promise<ReferenceLibraryReport> {
  // Exact row and case counts per format, scoped to the signed-in user by
  // the database itself rather than by a paged read.
  const { data: counts, error } = await supabase.rpc("reference_coverage");
  if (error) throw new Error(error.message);
  const own = new Set(["generic-bis", "generic-moaas", "generic-events"]);
  const coverage: FormatCoverage[] = ((counts ?? []) as any[]).map((r) => ({
    formatId: String(r.format_id),
    rows: Number(r.row_count ?? 0),
    cases: Number(r.case_count ?? 0),
    own: own.has(String(r.format_id)),
  }));

  const { data: sessionRows } = await supabase
    .from("eeg_sessions")
    .select("id, case_code, started_at, duration_seconds")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(60);

  const sessions: ReferenceLibraryReport["sessions"] = [];
  for (const s of (sessionRows ?? []) as any[]) {
    const { count } = await supabase
      .from("eeg_epochs")
      .select("id", { count: "exact", head: true })
      .eq("session_id", s.id)
      .not("depth_index", "is", null);
    sessions.push({
      id: String(s.id),
      caseCode: s.case_code ?? null,
      startedAt: String(s.started_at),
      durationSeconds: Number(s.duration_seconds ?? 0),
      scoredEpochs: count ?? 0,
    });
  }

  return { coverage, sessions, generatedAt: new Date().toISOString() };
}

export interface ImportOutcome {
  pairedInserted: number;
  labelsInserted: number;
  /** Rows with no scored moment close enough to pair against. */
  unmatched: number;
  note: string;
}

/** Furthest an uploaded reading may sit from a scored moment, in seconds. */
export const MATCH_WINDOW_SECONDS = 15;

export async function importReferenceRows(
  supabase: Client,
  userId: string,
  input: { sessionId: string; formatId: string; lineageKey: string; rows: ReferenceRow[] },
): Promise<ImportOutcome> {
  const format = formatById(input.formatId);
  if (!format) throw new Error("Unknown reference format.");

  if (format.kind === "bis-monitor") {
    // Pair each monitor reading with the app's own score at the same moment.
    const epochs: { at: number; index: number; sr: number | null; sef: number | null }[] = [];
    const PAGE = 1000;
    for (let from = 0; from < 6000; from += PAGE) {
      const { data, error } = await supabase
        .from("eeg_epochs")
        .select("t_offset_seconds, depth_index, suppression_ratio, spectral_edge_95")
        .eq("user_id", userId)
        .eq("session_id", input.sessionId)
        .not("depth_index", "is", null)
        .order("t_offset_seconds", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as any[];
      for (const r of page)
        epochs.push({
          at: Number(r.t_offset_seconds),
          index: Number(r.depth_index),
          sr: r.suppression_ratio == null ? null : Number(r.suppression_ratio),
          sef: r.spectral_edge_95 == null ? null : Number(r.spectral_edge_95),
        });
      if (page.length < PAGE) break;
    }
    if (!epochs.length) throw new Error("That recording has no scored moments to pair against.");

    let unmatched = 0;
    const seen = new Set<number>();
    const points = [];
    for (const row of input.rows) {
      if (row.bis == null) continue;
      let best = epochs[0]!;
      for (const e of epochs) if (Math.abs(e.at - row.at) < Math.abs(best.at - row.at)) best = e;
      if (Math.abs(best.at - row.at) > MATCH_WINDOW_SECONDS) {
        unmatched++;
        continue;
      }
      if (seen.has(best.at)) continue;
      seen.add(best.at);
      points.push({
        user_id: userId,
        session_id: input.sessionId,
        at_seconds: best.at,
        bis: row.bis,
        bis_sr: row.sr,
        bis_sef: row.sef,
        app_index: best.index,
        app_sr: best.sr,
        app_sef: best.sef,
        reliable: row.sqi == null ? true : row.sqi >= 50,
        sqi: row.sqi == null ? null : row.sqi / 100,
        ce: {},
        context: "reference upload",
        source_lineage: input.lineageKey,
      });
    }
    if (points.length) {
      const { error } = await supabase.from("bis_paired_points").insert(points as any);
      if (error) throw new Error(error.message);
    }
    return {
      pairedInserted: points.length,
      labelsInserted: 0,
      unmatched,
      note:
        unmatched > 0
          ? `${unmatched} readings sat more than ${MATCH_WINDOW_SECONDS} seconds from any scored moment and were left out rather than stretched to fit.`
          : "Every reading landed on a scored moment.",
    };
  }

  // Score sheets and event lists become state labels over intervals.
  const stated = input.rows.filter((r) => r.state != null).sort((a, b) => a.at - b.at);
  const labels = stated.map((row, i) => {
    const next = stated[i + 1];
    const end = row.duration != null ? row.at + row.duration : (next?.at ?? row.at + 60);
    return {
      user_id: userId,
      session_id: input.sessionId,
      label: row.state!,
      start_seconds: row.at,
      end_seconds: Math.max(row.at + 1, end),
      note:
        row.moaas != null
          ? `MOAA/S ${row.moaas} (uploaded ${format.label})`
          : `Uploaded ${format.label}`,
    };
  });
  if (labels.length) {
    const { error } = await supabase.from("depth_state_labels").insert(labels as any);
    if (error) throw new Error(error.message);
  }
  return {
    pairedInserted: 0,
    labelsInserted: labels.length,
    unmatched: input.rows.length - labels.length,
    note: labels.length
      ? "Each marker covers the stretch up to the next one, unless the file gave a duration."
      : "No usable markers were found in that file.",
  };
}
