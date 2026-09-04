import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildLineageHistories,
  summariseFolds,
  type FoldReport,
  type FoldScore,
  type Hyperparameter,
  type LineageHistory,
  type VersionRow,
} from "@/lib/eeg/training-history";
import {
  MAX_LINEAGES_PER_RUN,
  MIN_MAE_GAIN,
  MAX_CCC_LOSS,
  MIN_TRAINING_SQI,
} from "@/lib/eeg/coebis-refit";
import { MIN_POINTS, MIN_SESSIONS, KNOT_POSITIONS } from "@/lib/eeg/bis-drift";
import { MAX_TERM_ADJUSTMENT } from "@/lib/eeg/covariates";

export interface RunRow {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  validatedPoints: number;
  lineagesConsidered: number;
  lineagesRefitted: number;
  modelsPromoted: number;
  summary: string | null;
  rejected: Record<string, number>;
}

export interface TrainingHistory {
  lineages: LineageHistory[];
  runs: RunRow[];
  hyperparameters: Hyperparameter[];
}

const HYPERPARAMETERS: Hyperparameter[] = [
  {
    name: "Fitting method",
    value: "Ridge-penalised least squares (closed form)",
    note: "Solved in one step, so there is no epoch-by-epoch loss curve; each refit is one point on the history below.",
  },
  {
    name: "Scoring",
    value: "Leave-one-case-out",
    note: "Every fold holds one whole patient out of the fit and scores the model on that patient alone.",
  },
  {
    name: "Term shrinkage k",
    value: "20 readings",
    note: "A covariate term only reaches its full size once about 20 readings support it; thinner evidence is pulled toward no effect.",
  },
  {
    name: "Case shrinkage k",
    value: "12 readings",
    note: "Same idea per case, so one talkative case cannot pull the whole model.",
  },
  {
    name: "Maximum term adjustment",
    value: `±${MAX_TERM_ADJUSTMENT} index points`,
    note: "No single patient factor may move the number by more than this.",
  },
  {
    name: "Correction knots",
    value: KNOT_POSITIONS.join(", "),
    note: "The index positions where the curve is allowed to bend.",
  },
  {
    name: "Minimum signal quality",
    value: `SQI ≥ ${Math.round(MIN_TRAINING_SQI * 100)}%`,
    note: "Readings below this never enter the fit.",
  },
  {
    name: "Promotion gate",
    value: `${MIN_POINTS} readings across ${MIN_SESSIONS} cases`,
    note: "A setup cannot get its own model until it has this much paired evidence.",
  },
  {
    name: "Required improvement",
    value: `${MIN_MAE_GAIN.toFixed(2)} index points`,
    note: "A candidate must beat the model in force by this much on held-out patients.",
  },
  {
    name: "Agreement guard",
    value: `CCC may not fall by more than ${MAX_CCC_LOSS.toFixed(2)}`,
    note: "Blocks a promotion that lowers error but tracks the monitor less faithfully.",
  },
  {
    name: "Setups per run",
    value: String(MAX_LINEAGES_PER_RUN),
    note: "Keeps a scheduled run bounded; the rest are deferred to the next one.",
  },
];

export const getTrainingHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TrainingHistory> => {
    const [{ data: versionRows, error }, { data: runRows }] = await Promise.all([
      context.supabase
        .from("coebis_model_versions")
        .select(
          "lineage_key, version, model_family, promoted, is_active, mae_gain, reason, created_at, training, metrics_before, metrics_after, coefficients",
        )
        .order("created_at", { ascending: true })
        .limit(500),
      context.supabase
        .from("coebis_refit_runs")
        .select(
          "id, trigger, status, started_at, finished_at, validated_points, lineages_considered, lineages_refitted, models_promoted, summary, rejected",
        )
        .order("started_at", { ascending: false })
        .limit(25),
    ]);
    if (error) throw new Error(error.message);

    const runs: RunRow[] = ((runRows ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      id: String(r["id"]),
      trigger: String(r["trigger"]),
      status: String(r["status"]),
      startedAt: String(r["started_at"]),
      finishedAt: (r["finished_at"] as string | null) ?? null,
      validatedPoints: Number(r["validated_points"] ?? 0),
      lineagesConsidered: Number(r["lineages_considered"] ?? 0),
      lineagesRefitted: Number(r["lineages_refitted"] ?? 0),
      modelsPromoted: Number(r["models_promoted"] ?? 0),
      summary: (r["summary"] as string | null) ?? null,
      rejected: (r["rejected"] as Record<string, number> | null) ?? {},
    }));

    return {
      lineages: buildLineageHistories((versionRows ?? []) as unknown as VersionRow[]),
      runs,
      hyperparameters: HYPERPARAMETERS,
    };
  });

/**
 * Per-fold scores for one setup, computed live on the readings currently on
 * file. Each fold is one patient held entirely out of the fit.
 */
export const getFoldScores = createServerFn({ method: "GET" })
  .inputValidator((data) => z.object({ lineageKey: z.string().min(1) }).parse(data))
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }): Promise<FoldReport> => {
    const { loadTrainingMatrix } = await import("@/lib/eeg/coebis-training.server");
    const { selectValidatedPoints } = await import("@/lib/eeg/coebis-refit");
    const { crossValidateByCase } = await import("@/lib/eeg/coebis-covariates");

    const matrix = await loadTrainingMatrix(
      context.supabase,
      200000,
      context.userId,
      100000,
      data.lineageKey === "unlabelled" ? undefined : data.lineageKey,
    );
    const validated = selectValidatedPoints(matrix.points);
    const points = validated.used.filter(
      (p) => (p.lineageKey?.trim() || "unlabelled") === data.lineageKey,
    );
    if (!points.length) {
      return summariseFolds(data.lineageKey, "covariate", 0, [], null, null);
    }

    const labels = new Map<string, string>();
    for (const p of points) {
      const key = p.sessionId ?? "unfiled";
      if (!labels.has(key)) labels.set(key, key.startsWith("import:") ? key.slice(7) : key.slice(0, 8));
    }

    const cv = crossValidateByCase(points, "covariate");
    const folds: FoldScore[] = cv.foldErrors.map((f) => ({
      caseKey: f.caseKey,
      label: labels.get(f.caseKey) ?? f.caseKey.slice(0, 8),
      n: f.n,
      mae: f.mae,
    }));
    return summariseFolds(
      data.lineageKey,
      "covariate",
      points.length,
      folds,
      cv.inSample.mae ?? null,
      cv.outOfSample.mae ?? null,
    );
  });
