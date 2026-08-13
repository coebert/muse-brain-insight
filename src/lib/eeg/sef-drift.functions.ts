import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  analyseSefDrift,
  sefFitIsSafe,
  type SefDriftAnalysis,
  type SefDriftPoint,
} from "@/lib/eeg/sef-drift";

export interface ActiveSefAlignment {
  id: string;
  gain: number;
  offset: number;
  nPoints: number;
  nSessions: number;
  biasBefore: number | null;
  biasAfter: number | null;
  maeBefore: number | null;
  maeAfter: number | null;
  createdAt: string;
  note: string | null;
}

/** One paired SEF reading for the side-by-side chart, oldest first. */
export interface SefDriftSeriesPoint {
  i: number;
  monitorSef: number;
  /** Headband SEF as measured. */
  raw: number;
  /** Headband SEF after the active correction, when one exists. */
  corrected: number | null;
  recordedAt: string;
  sessionId: string | null;
}

export interface SefDriftReport {
  analysis: SefDriftAnalysis;
  active: ActiveSefAlignment | null;
  /** A new correction was fitted and activated during this call. */
  justApplied: boolean;
  series: SefDriftSeriesPoint[];
}

const num = (v: unknown): number | null =>
  v == null || !Number.isFinite(Number(v)) ? null : Number(v);

function toActive(row: Record<string, unknown>): ActiveSefAlignment {
  return {
    id: String(row["id"]),
    gain: num(row["gain"]) ?? 1,
    offset: num(row["offset"]) ?? 0,
    nPoints: Number(row["n_points"]) || 0,
    nSessions: Number(row["n_sessions"]) || 0,
    biasBefore: num(row["bias_before"]),
    biasAfter: num(row["bias_after"]),
    maeBefore: num(row["mae_before"]),
    maeAfter: num(row["mae_after"]),
    createdAt: String(row["created_at"]),
    note: (row["note"] as string | null) ?? null,
  };
}

const COLUMNS =
  'id, gain, "offset", n_points, n_sessions, bias_before, bias_after, mae_before, mae_after, is_active, created_at, note';

/**
 * Pooled SEF watch. Reads every paired SEF reading filed from cases, reports
 * the systematic offset against the commercial monitor and — once there is
 * enough evidence and the fit measurably improves agreement — activates the
 * correction so the displayed SEF sits on the monitor's scale.
 */
export const getSefDrift = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SefDriftReport> => {
    const { data: rows, error } = await context.supabase
      .from("bis_paired_points")
      .select("at_seconds, bis_sef, app_sef, session_id, reliable, recorded_at")
      .not("bis_sef", "is", null)
      .not("app_sef", "is", null)
      .order("recorded_at", { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);

    const points: SefDriftPoint[] = (rows ?? []).map((r) => ({
      at: Number(r.at_seconds),
      monitorSef: Number(r.bis_sef),
      appSef: Number(r.app_sef),
      sessionId: (r.session_id as string | null) ?? null,
      reliable: Boolean(r.reliable),
      recordedAt: String(r.recorded_at),
    }));

    const { data: activeRows } = await context.supabase
      .from("sef_alignments")
      .select(COLUMNS)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1);
    let active = activeRows?.[0] ? toActive(activeRows[0] as Record<string, unknown>) : null;

    const analysis = analyseSefDrift(points, active);
    const fit = analysis.fit;
    let justApplied = false;

    // Refit whenever the new fit is safe, backed by at least the provisional
    // evidence bar, and better than whatever is in force.
    const betterThanActive =
      active == null ||
      fit == null ||
      active.maeAfter == null ||
      fit.maeAfter <= active.maeAfter - 0.05 ||
      fit.n >= active.nPoints + 10;

    if (
      fit &&
      sefFitIsSafe(fit) &&
      analysis.readiness.provisional.met &&
      analysis.readiness.biasSignificant &&
      betterThanActive
    ) {
      const confirmed =
        analysis.readiness.points.have >= analysis.readiness.points.need &&
        analysis.readiness.sessions.have >= analysis.readiness.sessions.need;
      await context.supabase
        .from("sef_alignments")
        .update({ is_active: false })
        .eq("user_id", context.userId);
      const { data: inserted, error: insertError } = await context.supabase
        .from("sef_alignments")
        .insert({
          user_id: context.userId,
          gain: fit.gain,
          offset: fit.offset,
          n_points: fit.n,
          n_sessions: fit.sessions,
          bias_before: fit.biasBefore,
          bias_after: fit.biasAfter,
          mae_before: fit.maeBefore,
          mae_after: fit.maeAfter,
          auto_applied: true,
          is_active: true,
          note: `${confirmed ? "SEF correction" : "Provisional SEF correction"} fitted from ${fit.n} paired readings across ${fit.sessions} case${fit.sessions === 1 ? "" : "s"}.`,
        })
        .select(COLUMNS)
        .single();
      if (!insertError && inserted) {
        active = toActive(inserted as Record<string, unknown>);
        justApplied = true;
      }
    }

    const series: SefDriftSeriesPoint[] = points.slice(-120).map((p, i) => ({
      i: i + 1,
      monitorSef: Number(p.monitorSef.toFixed(2)),
      raw: Number(p.appSef.toFixed(2)),
      corrected: active
        ? Number((active.gain * p.appSef + active.offset).toFixed(2))
        : null,
      recordedAt: p.recordedAt,
      sessionId: p.sessionId,
    }));

    return { analysis, active, justApplied, series };
  });

/** Drop the SEF correction so the raw headband edge frequency is shown again. */
export const clearSefAlignment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ cleared: boolean }> => {
    const { error } = await context.supabase
      .from("sef_alignments")
      .update({ is_active: false })
      .eq("user_id", context.userId)
      .eq("is_active", true);
    if (error) throw new Error(error.message);
    return { cleared: true };
  });