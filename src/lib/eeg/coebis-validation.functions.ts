import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  crossValidateByCase,
  fitCoebisModel,
  outOfFoldPredictions,
  stratifiedAgreement,
  subgroupGaps,
  type AgreementSummary,
  type CoebisCvResult,
  type CoebisFamily,
  type StratumResult,
  type SubgroupGap,
} from "@/lib/eeg/coebis-covariates";
import { AGE_BANDS, REGIMENS, type CovariateTerm } from "@/lib/eeg/covariates";
import { selectCoebisTier, type CoebisTier, type TierCandidate } from "@/lib/eeg/coebis-tiers";

export interface CoebisValidationReport {
  n: number;
  cases: number;
  unfiled: number;
  missingAge: number;
  missingRegimen: number;
  /** Head-to-head, every figure computed leaving the case out of the fit. */
  families: CoebisCvResult[];
  /** Held-out error per subgroup for the covariate model. */
  strata: StratumResult[];
  /** Subgroups still too thin to earn their own correction. */
  gaps: SubgroupGap[];
  /** Patient-specific corrections the current data supports. */
  terms: CovariateTerm[];
  /** Raw headband index against the monitor, for reference. */
  baseline: AgreementSummary;
  /** Which family currently wins on held-out mean absolute error. */
  best: CoebisFamily | null;
  /** The model tier the current data supports, and why. */
  tier: CoebisTier;
  tierNote: string;
  tierCandidates: TierCandidate[];
  summary: string;
}

const FAMILIES: CoebisFamily[] = ["raw", "affine", "covariate", "mixed"];

const label: Record<CoebisFamily, string> = {
  raw: "published OpenIBIS",
  affine: "pooled COEBIS",
  covariate: "patient-adjusted COEBIS",
  mixed: "patient-adjusted COEBIS with per-case intercepts",
};

/**
 * Honest, leave-one-case-out validation of every COEBIS variant against the
 * transcribed commercial values. Nothing here is fitted and scored on the same
 * case, so the numbers say what the app would have produced on a patient it had
 * never seen.
 */
export const getCoebisValidation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CoebisValidationReport> => {
    const { loadTrainingMatrix } = await import("@/lib/eeg/coebis-training.server");
    const matrix = await loadTrainingMatrix(context.supabase);
    const points = matrix.points;

    const families = FAMILIES.map((f) => crossValidateByCase(points, f));
    const baseline = families.find((f) => f.family === "raw")?.inSample ?? {
      n: 0,
      bias: null,
      mae: null,
      rmse: null,
      within5: null,
      within10: null,
      ccc: null,
    };

    const oof = outOfFoldPredictions(points, "covariate");
    const strata = stratifiedAgreement(points, (_p, i) => oof[i] ?? null);

    const selection = selectCoebisTier(points);
    const full = selection.model ?? fitCoebisModel(points, "covariate");
    const gaps = subgroupGaps(points, [
      { group: "age", levels: [...AGE_BANDS] },
      { group: "regimen", levels: REGIMENS.map((r) => r.key) },
      { group: "sex", levels: ["female", "male"] },
    ]);

    const scored = families
      .filter((f) => f.outOfSample.mae != null)
      .sort((a, b) => a.outOfSample.mae! - b.outOfSample.mae!);
    const best = scored[0]?.family ?? null;
    const bestMae = scored[0]?.outOfSample.mae ?? null;
    const rawMae = families.find((f) => f.family === "raw")?.outOfSample.mae ?? null;

    const summary =
      points.length < 10
        ? `Only ${points.length} paired reading${points.length === 1 ? "" : "s"} logged so far — at least a few readings across two or more cases are needed before held-out validation means anything.`
        : best == null
          ? "Not enough cases to hold one out yet; log paired readings from another case to start validating."
          : `On readings from cases the model never saw, the ${label[best]} gives a mean absolute error of ${bestMae?.toFixed(1)} index points against the monitor${
              rawMae != null && bestMae != null
                ? `, versus ${rawMae.toFixed(1)} for the published index`
                : ""
            }. ${matrix.missingAge} reading${matrix.missingAge === 1 ? "" : "s"} came from cases with no age band and ${matrix.missingRegimen} with no regimen recorded — filling those in is the quickest way to sharpen the patient-specific corrections.`;

    return {
      n: points.length,
      cases: matrix.cases,
      unfiled: matrix.unfiled,
      missingAge: matrix.missingAge,
      missingRegimen: matrix.missingRegimen,
      families,
      strata,
      gaps,
      terms: full?.terms ?? [],
      baseline,
      best,
      tier: selection.tier,
      tierNote: selection.note,
      tierCandidates: selection.candidates,
      summary,
    };
  });
