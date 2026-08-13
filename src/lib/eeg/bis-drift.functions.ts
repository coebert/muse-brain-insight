import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AI_MODEL_VERSION } from "@/lib/eeg/interpret.functions";
import { streamGatewayText } from "@/lib/eeg/gateway.server";
import {
  analyseBisDrift,
  fitIsSafe,
  alignIndex,
  type BisDriftAnalysis,
  type BisDriftPoint,
} from "@/lib/eeg/bis-drift";

export interface ActiveAlignment {
  id: string;
  gain: number;
  offset: number;
  knots: { x: number; dy: number }[];
  modelVersion: string;
  nPoints: number;
  nSessions: number;
  maeBefore: number | null;
  maeAfter: number | null;
  biasBefore: number | null;
  biasAfter: number | null;
  autoApplied: boolean;
  createdAt: string;
  note: string | null;
}

/** One point of the side-by-side comparison series, oldest first. */
export interface BisDriftSeriesPoint {
  /** Position in the pooled series (1 = oldest shown). */
  i: number;
  bis: number;
  /** Open index as published, before any fitted correction. */
  raw: number;
  /** COEBIS: the open index after the active proprietary correction. */
  corrected: number | null;
  reliable: boolean;
  recordedAt: string;
  sessionId: string | null;
}

export interface BisDriftReport {
  analysis: BisDriftAnalysis;
  active: ActiveAlignment | null;
  /** An adjustment was fitted and activated during this call. */
  justApplied: boolean;
  history: ActiveAlignment[];
  /** Most recent paired readings for the side-by-side chart, oldest first. */
  series: BisDriftSeriesPoint[];
}

interface AlignmentRow {
  id: string;
  gain: number | string;
  offset: number | string;
  n_points: number;
  n_sessions: number;
  bias_before: number | string | null;
  bias_after: number | string | null;
  mae_before: number | string | null;
  mae_after: number | string | null;
  auto_applied: boolean;
  is_active: boolean;
  created_at: string;
  note: string | null;
  knots?: unknown;
  model_version?: string | null;
}

const num = (v: number | string | null): number | null =>
  v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;

function toAlignment(row: AlignmentRow): ActiveAlignment {
  return {
    id: row.id,
    gain: num(row.gain) ?? 1,
    offset: num(row.offset) ?? 0,
    knots: Array.isArray(row.knots)
      ? (row.knots as { x: number; dy: number }[])
          .map((k) => ({ x: Number(k.x), dy: Number(k.dy) }))
          .filter((k) => Number.isFinite(k.x) && Number.isFinite(k.dy))
      : [],
    modelVersion: row.model_version ?? "coebis-1",
    nPoints: row.n_points,
    nSessions: row.n_sessions,
    biasBefore: num(row.bias_before),
    biasAfter: num(row.bias_after),
    maeBefore: num(row.mae_before),
    maeAfter: num(row.mae_after),
    autoApplied: row.auto_applied,
    createdAt: row.created_at,
    note: row.note,
  };
}

const ALIGNMENT_COLUMNS =
  'id, gain, "offset", knots, model_version, n_points, n_sessions, bias_before, bias_after, mae_before, mae_after, auto_applied, is_active, created_at, note';

/** File the paired BIS/app values from a case so the pooled watch can use them. */
export const recordBisPoints = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      sessionId?: string | null;
      context?: string | null;
      device?: string | null;
      points: {
        at: number;
        bis: number;
        bisSr?: number | null;
        bisSef?: number | null;
        appIndex: number;
        appSr?: number | null;
        appSef?: number | null;
        reliable?: boolean;
        sqi?: number | null;
      }[];
    }) => {
      if (!input || !Array.isArray(input.points)) throw new Error("No paired points supplied.");
      const points = input.points.filter(
        (p) => Number.isFinite(p.at) && Number.isFinite(p.bis) && Number.isFinite(p.appIndex),
      );
      return { ...input, points: points.slice(0, 500) };
    },
  )
  .handler(async ({ data, context }): Promise<{ inserted: number }> => {
    if (!data.points.length) return { inserted: 0 };
    const rows = data.points.map((p) => ({
      user_id: context.userId,
      session_id: data.sessionId ?? null,
      at_seconds: Number(p.at.toFixed(2)),
      bis: p.bis,
      bis_sr: p.bisSr ?? null,
      bis_sef: p.bisSef ?? null,
      app_index: p.appIndex,
      app_sr: p.appSr ?? null,
      app_sef: p.appSef ?? null,
      reliable: p.reliable ?? true,
      sqi: p.sqi ?? null,
      context: data.context ?? null,
      device: data.device ?? null,
    }));
    const { error } = await context.supabase.from("bis_paired_points").insert(rows);
    if (error) throw new Error(error.message);
    return { inserted: rows.length };
  });

function toDriftPoints(rows: Record<string, unknown>[]): BisDriftPoint[] {
  return rows.map((r) => ({
    at: Number(r["at_seconds"]),
    bis: Number(r["bis"]),
    appIndex: Number(r["app_index"]),
    sessionId: (r["session_id"] as string | null) ?? null,
    reliable: Boolean(r["reliable"]),
    sqi: r["sqi"] == null ? null : Number(r["sqi"]),
    recordedAt: String(r["recorded_at"]),
    context: (r["context"] as string | null) ?? null,
  }));
}

/**
 * Attach a saved session to paired points that were filed live during the
 * case (before the session had an id), so the pooled fit keeps counting
 * independent cases correctly.
 */
export const linkBisPointsToSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sessionId: string; sinceIso: string }) => {
    if (!input?.sessionId) throw new Error("No session supplied.");
    const since = new Date(input.sinceIso);
    if (Number.isNaN(since.getTime())) throw new Error("Invalid case start time.");
    return { sessionId: input.sessionId, sinceIso: since.toISOString() };
  })
  .handler(async ({ data, context }): Promise<{ linked: boolean }> => {
    const { error } = await context.supabase
      .from("bis_paired_points")
      .update({ session_id: data.sessionId })
      .eq("user_id", context.userId)
      .is("session_id", null)
      .gte("recorded_at", data.sinceIso);
    if (error) throw new Error(error.message);
    return { linked: true };
  });

/**
 * Pooled BIS watch. Reads every filed paired point, reports the systematic
 * offset, and — once there is enough evidence across enough cases and the
 * fitted correction measurably improves agreement — activates that correction
 * automatically so the live index tracks the commercial monitor more closely.
 */
export const getBisDrift = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BisDriftReport> => {
    const { data: pointRows, error: pointsError } = await context.supabase
      .from("bis_paired_points")
      .select("at_seconds, bis, app_index, session_id, reliable, sqi, recorded_at, context")
      .order("recorded_at", { ascending: true })
      .limit(5000);
    if (pointsError) throw new Error(pointsError.message);
    const points = toDriftPoints((pointRows ?? []) as unknown as Record<string, unknown>[]);

    const { data: rows, error } = await context.supabase
      .from("depth_bis_alignments")
      .select(ALIGNMENT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    const history = ((rows ?? []) as unknown as AlignmentRow[]).map(toAlignment);
    let active =
      history.find((_, i) => ((rows ?? []) as unknown as AlignmentRow[])[i]!.is_active) ?? null;

    let analysis = analyseBisDrift(points, active);
    let justApplied = false;

    // Auto-adjust: enough evidence, a meaningful and statistically clear bias,
    // and a fitted correction that is both safe and materially better than
    // what is already applied.
    const fit = analysis.fit;
    const knotShift = fit
      ? Math.max(
          0,
          ...fit.knots.map((k) => {
            const prev = active?.knots.find((a) => a.x === k.x)?.dy ?? 0;
            return Math.abs(prev - k.dy);
          }),
        )
      : 0;
    const worthReplacing =
      !active ||
      Math.abs(fit ? fit.biasAfter : 0) + 1 < Math.abs(analysis.bias ?? 0) ||
      Math.abs((active.gain ?? 1) - (fit?.gain ?? 1)) > 0.05 ||
      Math.abs((active.offset ?? 0) - (fit?.offset ?? 0)) > 3 ||
      // COEBIS also refreshes when only the per-band finessing has moved.
      knotShift > 1.5 ||
      (fit != null && fit.n >= active.nPoints * 1.25 + 10);

    if (
      fit &&
      fitIsSafe(fit) &&
      // A provisional model is fitted as soon as there is early evidence, so a
      // clinician sees a COEBIS number instead of a dash for weeks; it is
      // stored and labelled as provisional until the full bar is cleared.
      analysis.readiness.provisional.met &&
      // Once COEBIS exists it keeps refining on new data; the first activation
      // still needs a clear, meaningful systematic offset.
      (active != null || (analysis.readiness.biasSignificant && Math.abs(analysis.bias ?? 0) >= 3)) &&
      worthReplacing
    ) {
      const confirmed =
        analysis.readiness.points.have >= analysis.readiness.points.need &&
        analysis.readiness.sessions.have >= analysis.readiness.sessions.need;
      await context.supabase
        .from("depth_bis_alignments")
        .update({ is_active: false })
        .eq("user_id", context.userId);
      const { data: inserted, error: insertError } = await context.supabase
        .from("depth_bis_alignments")
        .insert({
          user_id: context.userId,
          gain: fit.gain,
          offset: fit.offset,
          knots: fit.knots.map((k) => ({ x: k.x, dy: k.dy })) as unknown as Record<string, number>[],
          model_version: confirmed ? "coebis-2" : "coebis-2-provisional",
          n_points: fit.n,
          n_sessions: fit.sessions,
          bias_before: fit.biasBefore,
          bias_after: fit.biasAfter,
          mae_before: fit.maeBefore,
          mae_after: fit.maeAfter,
          auto_applied: true,
          is_active: true,
          note: confirmed
            ? `COEBIS refitted automatically from ${fit.n} paired readings across ${fit.sessions} cases.`
            : `Provisional COEBIS fitted from ${fit.n} paired readings across ${fit.sessions} cases — indicative until 30 readings across 3 cases confirm it.`,
        })
        .select(ALIGNMENT_COLUMNS)
        .single();
      if (insertError) throw new Error(insertError.message);
      active = toAlignment(inserted as unknown as AlignmentRow);
      history.unshift(active);
      justApplied = true;
      analysis = analyseBisDrift(points, active);
    }

    const usable = points.filter(
      (p) => Number.isFinite(p.bis) && Number.isFinite(p.appIndex),
    );
    const tail = usable.slice(-200);
    const series: BisDriftSeriesPoint[] = tail.map((p, i) => ({
      i: i + 1,
      bis: Number(p.bis.toFixed(1)),
      raw: Number(p.appIndex.toFixed(1)),
      corrected: active
        ? Number(
            alignIndex(p.appIndex, {
              gain: active.gain,
              offset: active.offset,
              knots: active.knots,
            }).toFixed(1),
          )
        : null,
      reliable: p.reliable,
      recordedAt: p.recordedAt,
      sessionId: p.sessionId,
    }));

    return { analysis, active, justApplied, history: history.slice(0, 10), series };
  });

/** Turn the automatic correction off and go back to the published scale. */
export const clearBisAlignment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ cleared: true }> => {
    const { error } = await context.supabase
      .from("depth_bis_alignments")
      .update({ is_active: false })
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { cleared: true };
  });

export interface BisDriftReview {
  headline: string;
  reading: string;
  recommendation: string;
  cautions: string[];
  modelVersion?: string;
}

const REVIEW_PROMPT = `You are a clinical measurement-agreement analyst supervising an app's open, non-proprietary depth-of-anaesthesia index (an OpenIBIS-style index from a frontal Muse 2 montage) against commercial BIS values a clinician transcribed at the bedside across many cases.

You receive a JSON digest of the pooled comparison: number of paired readings, number of cases, mean offset (app minus BIS; positive means the app reads LIGHTER), SD, 95 % confidence interval of the offset, mean absolute error, Pearson r, per-depth-band offsets, the offset over the most recent readings, any fitted gain/offset correction with the error before and after applying it, and whether a correction is currently active.

Judge: is the offset systematic or scatter? Is it uniform across depth bands or worse at one end? Is the fitted correction justified at this sample size, or should the app keep watching? If a correction is active, is it still doing its job or has the residual offset re-emerged?

Hard rules:
- Never claim to reproduce or validate against BIS; it is proprietary. Frame everything as agreement and trend alignment.
- Never invent numbers; quote only values in the digest, with units (index points).
- Fewer than about 30 paired readings across 3 cases is not enough to adjust anything — say so plainly.
- Never state a diagnosis or a dosing instruction.

Return ONLY minified JSON: {"headline":string,"reading":string,"recommendation":string,"cautions":[string]}`;

export const reviewBisDrift = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { digest: unknown }) => {
    if (!input || typeof input.digest !== "object" || input.digest === null) {
      throw new Error("A drift digest is required.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<BisDriftReview> => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("AI is not configured for this project.");

    const text = await streamGatewayText(
      {
        model: AI_MODEL_VERSION,
        stream: true,
        input: [
          { role: "system", content: REVIEW_PROMPT },
          {
            role: "user",
            content: `Pooled BIS drift digest (JSON):\n${JSON.stringify(data.digest)}`,
          },
        ],
        reasoning: { effort: "medium", summary: "auto" },
        store: false,
      },
      apiKey,
    );

    const cleaned = text
      .replace(/^\s*```(?:json)?/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("The AI response could not be parsed.");
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as BisDriftReview;
    return {
      headline: parsed.headline ?? "",
      reading: parsed.reading ?? "",
      recommendation: parsed.recommendation ?? "",
      cautions: Array.isArray(parsed.cautions) ? parsed.cautions.slice(0, 6) : [],
      modelVersion: AI_MODEL_VERSION,
    };
  });
