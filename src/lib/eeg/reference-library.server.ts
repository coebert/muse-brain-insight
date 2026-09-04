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

async function countRows(
  supabase: Client,
  build: () => any,
): Promise<{ rows: number; cases: number }> {
  const { count } = await build();
  return { rows: count ?? 0, cases: 0 };
}

export async function loadReferenceLibrary(
  supabase: Client,
  userId: string,
): Promise<ReferenceLibraryReport> {
  const coverage: FormatCoverage[] = [];

  const vitaldb = await countRows(supabase, () =>
    supabase
      .from("external_reference_points")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("source", "vitaldb"),
  );
  const { data: vitalCases } = await supabase
    .from("external_reference_points")
    .select("case_ref")
    .eq("user_id", userId)
    .eq("source", "vitaldb")
    .limit(10000);
  coverage.push({
    formatId: "vitaldb-bis",
    rows: vitaldb.rows,
    cases: new Set((vitalCases ?? []).map((r: any) => r.case_ref)).size,
    own: false,
  });

  const perLineage = async (formatId: string, like: string) => {
    const { data } = await supabase
      .from("bis_paired_points")
      .select("session_id, external_ref")
      .eq("user_id", userId)
      .like("source_lineage", like)
      .limit(60000);
    const rows = data ?? [];
    coverage.push({
      formatId,
      rows: rows.length,
      cases: new Set(rows.map((r: any) => r.session_id ?? r.external_ref)).size,
      own: false,
    });
  };
  await perLineage("figshare-ma-bis", "figshare%");

  const labelled = async (formatId: string, lineageLike: string, labelSource?: string) => {
    let q = supabase
      .from("external_spectral_epochs")
      .select("case_ref")
      .eq("user_id", userId)
      .like("source_lineage", lineageLike)
      .not("label", "is", null)
      .limit(60000);
    if (labelSource) q = q.eq("label_source", labelSource);
    const { data } = await q;
    const rows = data ?? [];
    coverage.push({
      formatId,
      rows: rows.length,
      cases: new Set(rows.map((r: any) => r.case_ref)).size,
      own: false,
    });
  };
  await labelled("dose1-moaas", "%dose-i%", "moaas");
  await labelled("bids-events", "%ds004541%");

  // The user's own uploads: paired readings filed from a monitor export, and
  // state labels written from a score sheet or event list.
  const { data: ownPaired } = await supabase
    .from("bis_paired_points")
    .select("session_id")
    .eq("user_id", userId)
    .eq("context", "reference upload")
    .limit(20000);
  coverage.push({
    formatId: "generic-bis",
    rows: (ownPaired ?? []).length,
    cases: new Set((ownPaired ?? []).map((r: any) => r.session_id)).size,
    own: true,
  });

  const { data: ownLabels } = await supabase
    .from("depth_state_labels")
    .select("session_id, note")
    .eq("user_id", userId)
    .limit(20000);
  const labelRows = ownLabels ?? [];
  const moaasRows = labelRows.filter((r: any) => String(r.note ?? "").includes("MOAA/S"));
  const eventRows = labelRows.filter((r: any) => !String(r.note ?? "").includes("MOAA/S"));
  coverage.push({
    formatId: "generic-moaas",
    rows: moaasRows.length,
    cases: new Set(moaasRows.map((r: any) => r.session_id)).size,
    own: true,
  });
  coverage.push({
    formatId: "generic-events",
    rows: eventRows.length,
    cases: new Set(eventRows.map((r: any) => r.session_id)).size,
    own: true,
  });

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
