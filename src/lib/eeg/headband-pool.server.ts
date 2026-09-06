/**
 * Server side of the headband training pool: load the paired bedside
 * readings for the headband lineage, attach each recording's depth exposure
 * and confirmed outcome, and optionally run the outcome-graded refit.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadTrainingMatrix } from "./coebis-training.server";
import { selectValidatedPoints } from "./coebis-refit";
import { modelFromRow } from "./coebis-refit.server";
import { MUSE_LINEAGE_KEY } from "./pairing-worklist.server";
import {
  buildHeadbandPool,
  refitHeadbandWithOutcomes,
  type CaseOutcomeRow,
  type HeadbandPool,
  type OutcomeAwareFit,
  type PoolCase,
} from "./headband-pool";

type Client = SupabaseClient<any, any, any>;

export interface HeadbandPoolReport {
  lineageKey: string;
  readings: number;
  /** Readings dropped by the shared validation gate before fitting. */
  rejected: number;
  pairedCases: number;
  unpairedCases: number;
  casesWithOutcome: number;
  adverseCases: number;
  cases: PoolCase[];
  fit: OutcomeAwareFit;
  /** Whether a candidate was written and made active. */
  promoted: boolean;
  version: number | null;
}

async function loadPool(
  supabase: Client,
  userId: string,
  lineageKey: string,
): Promise<{ pool: HeadbandPool; rejected: number }> {
  const matrix = await loadTrainingMatrix(supabase, 5000, userId, 5000, lineageKey);
  const validated = selectValidatedPoints(matrix.points);

  // Every recording taken with this headband, paired or not: an unpaired
  // recording contributes no training row but still belongs in the picture.
  const { data: sessionRows, error } = await supabase
    .from("eeg_sessions")
    .select("id, case_code, started_at")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(400);
  if (error) throw new Error(error.message);
  const sessions = (sessionRows ?? []) as unknown as Record<string, unknown>[];
  const ids = sessions.map((s) => String(s["id"]));

  const exposure = new Map<string, { epochs: number; meanDepth: number | null; deepEpochs: number }>();
  if (ids.length) {
    const { data: rows } = await supabase.rpc("session_depth_exposure", { _session_ids: ids });
    for (const r of ((rows ?? []) as unknown as Record<string, unknown>[])) {
      exposure.set(String(r["session_id"]), {
        epochs: Number(r["epochs"] ?? 0),
        meanDepth: r["mean_depth"] == null ? null : Number(r["mean_depth"]),
        deepEpochs: Number(r["deep_epochs"] ?? 0),
      });
    }
  }

  const outcomes = new Map<string, CaseOutcomeRow>();
  if (ids.length) {
    const { data: rows } = await supabase
      .from("case_outcomes")
      .select("session_id, delirium, emergence, awareness, unplanned_icu, mortality_30d")
      .eq("user_id", userId)
      .in("session_id", ids);
    for (const r of ((rows ?? []) as unknown as Record<string, unknown>[])) {
      outcomes.set(String(r["session_id"]), {
        sessionId: String(r["session_id"]),
        delirium: (r["delirium"] as string | null) ?? null,
        emergence: (r["emergence"] as string | null) ?? null,
        awareness: (r["awareness"] as boolean | null) ?? null,
        unplannedIcu: (r["unplanned_icu"] as boolean | null) ?? null,
        mortality30d: (r["mortality_30d"] as boolean | null) ?? null,
      });
    }
  }

  const pool = buildHeadbandPool(
    lineageKey,
    validated.used,
    sessions
      .map((s) => {
        const id = String(s["id"]);
        const ex = exposure.get(id);
        return {
          sessionId: id,
          caseCode: (s["case_code"] as string | null) ?? null,
          epochs: ex?.epochs ?? 0,
          meanDepth: ex?.meanDepth ?? null,
          deepEpochs: ex?.deepEpochs ?? 0,
          outcome: outcomes.get(id) ?? null,
        };
      })
      // Recordings with neither a paired reading nor scored epochs contribute
      // nothing and would only pad the table.
      .filter((c) => c.epochs > 0),
  );
  const rejected = Object.values(validated.rejected).reduce((a, b) => a + b, 0);
  return { pool, rejected };
}

/**
 * Read the pool and grade the current model on it, without fitting anything.
 */
export async function getHeadbandPoolReport(
  supabase: Client,
  userId: string,
  lineageKey: string = MUSE_LINEAGE_KEY,
): Promise<HeadbandPoolReport> {
  const { pool, rejected } = await loadPool(supabase, userId, lineageKey);
  const incumbent = await loadIncumbent(supabase, userId, lineageKey);
  const fit = refitHeadbandWithOutcomes(pool, incumbent.model);
  return {
    lineageKey,
    readings: pool.readings,
    rejected,
    pairedCases: pool.pairedCases,
    unpairedCases: pool.unpairedCases,
    casesWithOutcome: pool.casesWithOutcome,
    adverseCases: pool.adverseCases,
    cases: pool.cases,
    fit,
    promoted: false,
    version: null,
  };
}

async function loadIncumbent(supabase: Client, userId: string, lineageKey: string) {
  const { data } = await supabase
    .from("coebis_model_versions")
    .select("lineage_key, version, model_family, coefficients, is_active")
    .eq("user_id", userId)
    .eq("lineage_key", lineageKey)
    .order("version", { ascending: false })
    .limit(20);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const active = rows.find((r) => r["is_active"]);
  const maxVersion = rows.reduce((m, r) => Math.max(m, Number(r["version"] ?? 0)), 0);
  return { model: modelFromRow(active ?? null), maxVersion };
}

/**
 * Run the outcome-graded headband refit and persist the candidate. Promotion
 * still rests entirely on held-out agreement with the bedside monitor;
 * outcomes only appear in the record so the split can be audited later.
 */
export async function runHeadbandPoolRefit(
  supabase: Client,
  userId: string,
  lineageKey: string = MUSE_LINEAGE_KEY,
): Promise<HeadbandPoolReport> {
  const { pool, rejected } = await loadPool(supabase, userId, lineageKey);
  const incumbent = await loadIncumbent(supabase, userId, lineageKey);
  const fit = refitHeadbandWithOutcomes(pool, incumbent.model);

  let version: number | null = null;
  if (fit.model) {
    version = incumbent.maxVersion + 1;
    // Model version rows are insert-protected by RLS; write them with the
    // privileged client, still scoped to this user's id.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as Client;
    const { error } = await admin.from("coebis_model_versions").upsert(
      {
        user_id: userId,
        lineage_key: lineageKey,
        version,
        model_family: fit.family,
        coefficients: {
          gain: fit.model.gain,
          offset: fit.model.offset,
          knots: fit.model.knots,
          terms: fit.model.terms,
          ceTerms: fit.model.ceTerms,
          n: fit.model.n,
          sessions: fit.model.sessions,
        },
        training: {
          n: fit.n,
          cases: fit.cases,
          folds: fit.folds,
          provisional: fit.provisional,
          casesWithOutcome: fit.casesWithOutcome,
          adverseCases: fit.adverseCases,
          readingsWithOutcome: fit.readingsWithOutcome,
          strata: fit.strata,
        },
        metrics_before: { ...fit.before, source: fit.beforeSource },
        metrics_after: fit.after,
        mae_gain: fit.maeGain,
        promoted: fit.promote,
        is_active: fit.promote,
        reason: fit.reason,
        data_digest: `${fit.digest}:outcomes${fit.casesWithOutcome}`,
      },
      { onConflict: "user_id,lineage_key,data_digest", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);

    if (fit.promote) {
      await supabase
        .from("coebis_model_versions")
        .update({ is_active: false })
        .eq("user_id", userId)
        .eq("lineage_key", lineageKey)
        .eq("is_active", true)
        .neq("version", version);
    }
  }

  return {
    lineageKey,
    readings: pool.readings,
    rejected,
    pairedCases: pool.pairedCases,
    unpairedCases: pool.unpairedCases,
    casesWithOutcome: pool.casesWithOutcome,
    adverseCases: pool.adverseCases,
    cases: pool.cases,
    fit,
    promoted: fit.promote,
    version: fit.promote ? version : null,
  };
}
