import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { computeCoebisResiduals, type CoebisResiduals } from "@/lib/eeg/coebis-residuals";
import {
  KNOT_POSITIONS,
  MIN_POINTS,
  MIN_SESSIONS,
  alignIndex,
  analyseBisDrift,
  type BisDriftPoint,
} from "@/lib/eeg/bis-drift";

/** One paired reading exactly as the COEBIS fit sees it. */
export interface CoebisTrainingPoint {
  recordedAt: string;
  caseCode: string;
  sessionId: string | null;
  /** Case-clock seconds within its own case. */
  at: number;
  bis: number;
  /** Open index as published, before any correction. */
  raw: number;
  /** COEBIS output for that raw index under the active model. */
  corrected: number | null;
  /** raw − BIS; positive = the app read lighter. */
  diff: number;
  /** Residual after the active model, if one is fitted. */
  residual: number | null;
  reliable: boolean;
  sqi: number | null;
  context: string | null;
  /** True when this reading is in the set the current fit is made on. */
  usedInFit: boolean;
}

export interface CoebisCaseRow {
  sessionId: string | null;
  caseCode: string;
  points: number;
  reliablePoints: number;
  meanBias: number | null;
  firstRecordedAt: string;
  lastRecordedAt: string;
}

export interface CoebisKnotRow {
  x: number;
  /** Paired readings within the knot's neighbourhood on the aligned scale. */
  n: number;
  /** Correction the active model applies there, in index points. */
  dy: number | null;
}

export interface CoebisTrainingData {
  /** Every paired reading the model can see. */
  totalPoints: number;
  /** Readings in the set the fit is actually made on. */
  usedPoints: number;
  /** Readings held out of the fit (flagged unreliable at the time). */
  excludedPoints: number;
  /** Whether the fit uses only reliable readings or has to fall back to all. */
  fitBasis: "reliable" | "all";
  sessions: number;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  thresholds: { points: number; sessions: number };
  active: {
    gain: number;
    offset: number;
    modelVersion: string;
    createdAt: string;
    nPoints: number;
    nSessions: number;
    maeBefore: number | null;
    maeAfter: number | null;
    biasBefore: number | null;
    biasAfter: number | null;
  } | null;
  knots: CoebisKnotRow[];
  bands: { band: string; n: number; bias: number | null; meanAbsolute: number | null }[];
  cases: CoebisCaseRow[];
  /** Where the active fit agrees and where it fails, over every paired reading. */
  residuals: CoebisResiduals | null;
  /** Most recent readings, newest first, for inspection. */
  points: CoebisTrainingPoint[];
}

const KNOT_WINDOW = 10;
const round = (v: number, dp = 1) => Number(v.toFixed(dp));
const meanOf = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

/** Residual breakdown for one stored COEBIS fit, measured on the same readings. */
export interface CoebisVersionResiduals {
  id: string;
  /** Stable version number, counted from the oldest stored fit. */
  version: number;
  modelVersion: string;
  createdAt: string;
  isActive: boolean;
  gain: number;
  offset: number;
  /** Readings the fit itself was made on, as recorded at fit time. */
  nFitted: number;
  residuals: CoebisResiduals;
}

/** Newest fits kept for the side-by-side comparison. */
const COMPARE_LIMIT = 8;

/**
 * Everything the COEBIS model is currently learning from: the paired readings,
 * which ones are in the fit, how they are spread across cases and depth bands,
 * and the corrections the active model has learned at each knot.
 */
export const getCoebisTrainingData = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CoebisTrainingData> => {
    const { open } = await import("@/lib/privacy.server");

    const { data: pointRows, error } = await context.supabase
      .from("bis_paired_points")
      .select("at_seconds, bis, app_index, session_id, reliable, sqi, recorded_at, context")
      .order("recorded_at", { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);

    const points: BisDriftPoint[] = (pointRows ?? [])
      .map((r) => ({
        at: Number(r.at_seconds),
        bis: Number(r.bis),
        appIndex: Number(r.app_index),
        sessionId: r.session_id ?? null,
        reliable: Boolean(r.reliable),
        sqi: r.sqi == null ? null : Number(r.sqi),
        recordedAt: String(r.recorded_at),
        context: r.context ?? null,
      }))
      .filter((p) => Number.isFinite(p.bis) && Number.isFinite(p.appIndex));

    const { data: alignRow } = await context.supabase
      .from("depth_bis_alignments")
      .select(
        'id, gain, "offset", knots, model_version, n_points, n_sessions, bias_before, bias_after, mae_before, mae_after, created_at',
      )
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const num = (v: unknown): number | null =>
      v == null || !Number.isFinite(Number(v)) ? null : Number(v);

    const activeKnots = Array.isArray(alignRow?.knots)
      ? (alignRow.knots as { x: number; dy: number }[])
          .map((k) => ({ x: Number(k.x), dy: Number(k.dy) }))
          .filter((k) => Number.isFinite(k.x) && Number.isFinite(k.dy))
      : [];

    const active = alignRow
      ? {
          gain: num(alignRow.gain) ?? 1,
          offset: num(alignRow.offset) ?? 0,
          modelVersion: alignRow.model_version ?? "coebis-1",
          createdAt: String(alignRow.created_at),
          nPoints: alignRow.n_points,
          nSessions: alignRow.n_sessions,
          maeBefore: num(alignRow.mae_before),
          maeAfter: num(alignRow.mae_after),
          biasBefore: num(alignRow.bias_before),
          biasAfter: num(alignRow.bias_after),
        }
      : null;

    const map = (index: number): number | null =>
      active
        ? round(alignIndex(index, { gain: active.gain, offset: active.offset, knots: activeKnots }))
        : null;

    // The fit prefers readings the app judged reliable, and only falls back to
    // the whole pool when there are too few of those to fit on.
    const reliable = points.filter((p) => p.reliable);
    const fitBasis: "reliable" | "all" = reliable.length >= MIN_POINTS ? "reliable" : "all";
    const inFit = new Set(fitBasis === "reliable" ? reliable : points);

    // Case codes are stored sealed; resolve the ones referenced here.
    const sessionIds = Array.from(
      new Set(points.map((p) => p.sessionId).filter((id): id is string => Boolean(id))),
    );
    const codes = new Map<string, string>();
    if (sessionIds.length) {
      const { data: sessions } = await context.supabase
        .from("eeg_sessions")
        .select("id, case_code")
        .in("id", sessionIds.slice(0, 500));
      for (const s of sessions ?? []) {
        codes.set(s.id, open(s.case_code) ?? "unlabelled");
      }
    }
    const codeFor = (id: string | null) => (id ? (codes.get(id) ?? "unlabelled") : "unfiled");

    const analysis = analyseBisDrift(points, active);

    const byCase = new Map<string, BisDriftPoint[]>();
    for (const p of points) {
      const key = p.sessionId ?? "unfiled";
      const list = byCase.get(key);
      if (list) list.push(p);
      else byCase.set(key, [p]);
    }
    const cases: CoebisCaseRow[] = Array.from(byCase.entries())
      .map(([key, list]) => {
        const sorted = [...list].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
        const bias = meanOf(list.map((p) => p.appIndex - p.bis));
        return {
          sessionId: key === "unfiled" ? null : key,
          caseCode: codeFor(key === "unfiled" ? null : key),
          points: list.length,
          reliablePoints: list.filter((p) => p.reliable).length,
          meanBias: bias == null ? null : round(bias),
          firstRecordedAt: sorted[0]!.recordedAt,
          lastRecordedAt: sorted[sorted.length - 1]!.recordedAt,
        };
      })
      .sort((a, b) => b.lastRecordedAt.localeCompare(a.lastRecordedAt));

    // How much evidence sits behind each learned residual correction.
    const fitPoints = fitBasis === "reliable" ? reliable : points;
    const knots: CoebisKnotRow[] = KNOT_POSITIONS.map((x) => {
      const n = active
        ? fitPoints.filter(
            (p) => Math.abs(active.gain * p.appIndex + active.offset - x) <= KNOT_WINDOW,
          ).length
        : fitPoints.filter((p) => Math.abs(p.appIndex - x) <= KNOT_WINDOW).length;
      const knot = activeKnots.find((k) => k.x === x);
      return { x, n, dy: knot ? round(knot.dy, 2) : null };
    });

    const recent = [...points]
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, 300);

    // Residual breakdown runs over every paired reading, not just the recent
    // window shown in the table, so the percentages match the fitted model.
    const residuals = active
      ? computeCoebisResiduals(
          points.flatMap((p) => {
            const corrected = map(p.appIndex);
            if (corrected == null) return [];
            return [
              {
                residual: round(corrected - p.bis),
                bis: p.bis,
                recordedAt: p.recordedAt,
                caseCode: codeFor(p.sessionId),
                usedInFit: inFit.has(p),
              },
            ];
          }),
        )
      : null;

    return {
      totalPoints: points.length,
      usedPoints: fitPoints.length,
      excludedPoints: points.length - fitPoints.length,
      fitBasis,
      sessions: byCase.size,
      firstRecordedAt: points[0]?.recordedAt ?? null,
      lastRecordedAt: points[points.length - 1]?.recordedAt ?? null,
      thresholds: { points: MIN_POINTS, sessions: MIN_SESSIONS },
      active,
      knots,
      bands: analysis.bands,
      cases,
      residuals,
      points: recent.map((p) => {
        const corrected = map(p.appIndex);
        return {
          recordedAt: p.recordedAt,
          caseCode: codeFor(p.sessionId),
          sessionId: p.sessionId,
          at: p.at,
          bis: round(p.bis),
          raw: round(p.appIndex),
          corrected,
          diff: round(p.appIndex - p.bis),
          residual: corrected == null ? null : round(corrected - p.bis),
          reliable: p.reliable,
          sqi: p.sqi == null ? null : round(p.sqi),
          context: p.context ?? null,
          usedInFit: inFit.has(p),
        };
      }),
    };
  });

/**
 * Residual breakdowns for every stored COEBIS fit, each computed over the very
 * same pool of paired readings. Because the evidence is held constant, the
 * differences between versions are the model's doing — so a clinician can see
 * whether successive refits actually improved agreement, and where.
 */
export const getCoebisVersionResiduals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CoebisVersionResiduals[]> => {
    const { open } = await import("@/lib/privacy.server");

    const { data: pointRows, error } = await context.supabase
      .from("bis_paired_points")
      .select("bis, app_index, session_id, recorded_at, reliable")
      .order("recorded_at", { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);

    const points = (pointRows ?? [])
      .map((r) => ({
        bis: Number(r.bis),
        appIndex: Number(r.app_index),
        sessionId: r.session_id ?? null,
        recordedAt: String(r.recorded_at),
        reliable: Boolean(r.reliable),
      }))
      .filter((p) => Number.isFinite(p.bis) && Number.isFinite(p.appIndex));
    if (!points.length) return [];

    const { data: fitRows } = await context.supabase
      .from("depth_bis_alignments")
      .select('id, gain, "offset", knots, model_version, n_points, is_active, created_at')
      .order("created_at", { ascending: true })
      .limit(200);

    // Version numbers count from the oldest stored fit so a label never shifts
    // as new models are added; only the newest few are worth comparing.
    const numbered = (fitRows ?? [])
      .map((row, i) => ({ row, version: i + 1 }))
      .filter(({ row }) => Number.isFinite(Number(row.gain)) && Number.isFinite(Number(row.offset)))
      .slice(-COMPARE_LIMIT)
      .reverse();
    if (!numbered.length) return [];

    const sessionIds = Array.from(
      new Set(points.map((p) => p.sessionId).filter((id): id is string => Boolean(id))),
    );
    const codes = new Map<string, string>();
    if (sessionIds.length) {
      const { data: sessions } = await context.supabase
        .from("eeg_sessions")
        .select("id, case_code")
        .in("id", sessionIds.slice(0, 500));
      for (const s of sessions ?? []) codes.set(s.id, open(s.case_code) ?? "unlabelled");
    }
    const codeFor = (id: string | null) => (id ? (codes.get(id) ?? "unlabelled") : "unfiled");

    const reliableCount = points.filter((p) => p.reliable).length;
    const fitBasisReliable = reliableCount >= MIN_POINTS;

    return numbered.map(({ row, version }) => {
      const gain = Number(row.gain);
      const offset = Number(row.offset);
      const knots = Array.isArray(row.knots)
        ? (row.knots as { x: number; dy: number }[])
            .map((k) => ({ x: Number(k.x), dy: Number(k.dy) }))
            .filter((k) => Number.isFinite(k.x) && Number.isFinite(k.dy))
        : [];
      const residuals = computeCoebisResiduals(
        points.map((p) => ({
          residual: round(alignIndex(p.appIndex, { gain, offset, knots }) - p.bis),
          bis: p.bis,
          recordedAt: p.recordedAt,
          caseCode: codeFor(p.sessionId),
          usedInFit: fitBasisReliable ? p.reliable : true,
        })),
      );
      return {
        id: String(row.id),
        version,
        modelVersion: row.model_version ?? `coebis-${version}`,
        createdAt: String(row.created_at),
        isActive: Boolean(row.is_active),
        gain: round(gain, 3),
        offset: round(offset, 2),
        nFitted: Number(row.n_points) || 0,
        residuals,
      };
    });
  });