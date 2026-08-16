import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AgreementSummary, StratumResult } from "@/lib/eeg/coebis-covariates";
import type { Interval } from "@/lib/eeg/ci";

export interface ProspectiveLockSummary {
  id: string;
  label: string;
  note: string | null;
  lockedAt: string;
  modelVersion: number | null;
  modelFamily: string;
  isActive: boolean;
  /** Readings the model was fitted before the lock. */
  trainingReadings: number;
  /** Readings recorded since the lock — genuinely unseen. */
  unseenReadings: number;
  unseenCases: number;
}

export interface ProspectiveReport {
  locks: ProspectiveLockSummary[];
  activeLockId: string | null;
  /** Agreement of the locked model on readings taken since the lock. */
  prospective: AgreementSummary | null;
  /** The raw published index on the same unseen readings, for reference. */
  baseline: AgreementSummary | null;
  maeCi: Interval | null;
  biasCi: Interval | null;
  /** Unseen-data error by subgroup. */
  strata: StratumResult[];
  /** Bland-Altman points (mean, difference) on the unseen readings. */
  blandAltman: { mean: number; diff: number }[];
  summary: string;
}

/** Freeze the active COEBIS fit so later readings become prospective test data. */
export const lockCoebisModel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { label?: string; note?: string | null }) => input ?? {})
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const { data: alignment, error } = await context.supabase
      .from("depth_bis_alignments")
      .select('id, gain, "offset", knots, model_version, model_family, coefficients, n_points, n_sessions')
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!alignment) throw new Error("No active COEBIS model to lock yet.");

    const row = alignment as unknown as Record<string, unknown>;
    await context.supabase
      .from("coebis_locks")
      .update({ is_active: false })
      .eq("user_id", context.userId)
      .eq("is_active", true);

    const { data: inserted, error: insertError } = await context.supabase
      .from("coebis_locks")
      .insert({
        user_id: context.userId,
        alignment_id: String(row["id"]),
        label: data.label?.trim() || `Locked v${row["model_version"] ?? "?"}`,
        note: data.note ?? null,
        model_version: row["model_version"] == null ? null : Number(row["model_version"]),
        model_family: String(row["model_family"] ?? "affine"),
        coefficients: {
          gain: Number(row["gain"]),
          offset: Number(row["offset"]),
          knots: row["knots"] ?? [],
          terms: (row["coefficients"] as { terms?: unknown } | null)?.terms ?? [],
          n: Number(row["n_points"] ?? 0),
          sessions: Number(row["n_sessions"] ?? 0),
        } as unknown as never,
        is_active: true,
      })
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);
    return { id: String((inserted as unknown as Record<string, unknown>)["id"]) };
  });

/** Agreement of a locked model on the readings recorded since it was frozen. */
export const getProspectiveReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input?: { lockId?: string }) => input ?? {})
  .handler(async ({ data, context }): Promise<ProspectiveReport> => {
    const { buildProspectiveReport } = await import("@/lib/eeg/prospective-report.server");
    return buildProspectiveReport(context.supabase, data.lockId ?? null);
  });
