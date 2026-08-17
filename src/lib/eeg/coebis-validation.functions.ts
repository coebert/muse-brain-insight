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
import { benjaminiHochberg, pValueForMean } from "@/lib/eeg/fdr";
import { selectCoebisTier, type CoebisTier, type TierCandidate } from "@/lib/eeg/coebis-tiers";
import {
  buildDiscriminationReport,
  type DiscriminationReport,
} from "@/lib/eeg/discrimination-report";
import {
  calibrateDepthConfidence,
  type ConfidenceCalibration,
} from "@/lib/eeg/depth-confidence-calibration";

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
  /**
   * Subgroups whose residual bias survives false-discovery-rate control across
   * every subgroup tested — the ones worth acting on.
   */
  weakSpots: { group: string; level: string; n: number; bias: number | null; q: number }[];
  /** Subgroups still too thin to earn their own correction. */
  gaps: SubgroupGap[];
  /** Patient-specific corrections the current data supports. */
  terms: CovariateTerm[];
  /** Raw headband index against the monitor, for reference. */
  baseline: AgreementSummary;
  /** Which family currently wins on held-out mean absolute error. */
  best: CoebisFamily | null;
  /**
   * Pk and ROC/AUC for the published index, COEBIS and the monitor itself,
   * plus repeated-measures limits of agreement.
   */
  discrimination: DiscriminationReport;
  /** Whether the depth confidence cut-offs sit where the data puts them. */
  confidence: ConfidenceCalibration;
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

    // How the field validates a depth monitor: does the index order clinical
    // states correctly, and does it separate the boundaries that matter?
    const discrimination = buildDiscriminationReport(
      points.map((p) => ({ bis: p.bis, bisSr: null, sessionId: p.sessionId })),
      [
        { key: "raw", label: "Published open index", values: points.map((p) => p.appIndex) },
        { key: "coebis", label: "COEBIS (held-out)", values: oof },
        {
          key: "monitor",
          label: "Commercial monitor",
          values: points.map((p) => p.bis),
          reference: true,
        },
      ],
    );

    // Did the readings the app called reliable actually agree with the monitor?
    const confidence = calibrateDepthConfidence(
      points
        .filter((p) => p.depthConfidence != null && Number.isFinite(p.depthConfidence))
        .map((p) => ({
          confidence: p.depthConfidence as number,
          absError: Math.abs(p.appIndex - p.bis),
        })),
    );

    // Twenty subgroups tested at 5 % throws up a "weak spot" by chance in most
    // reports. Benjamini-Hochberg keeps the flagged ones meaningful.
    const tested = strata
      .filter((s) => s.after.n >= 5 && s.after.bias != null && s.after.rmse != null)
      .map((s) => {
        const spread = Math.sqrt(
          Math.max(0, (s.after.rmse ?? 0) ** 2 - (s.after.bias ?? 0) ** 2),
        );
        return { item: s, p: pValueForMean(s.after.bias, spread / Math.sqrt(s.after.n)) };
      });
    const weakSpots = benjaminiHochberg(tested)
      .filter((r) => r.significant)
      .map((r) => ({
        group: r.item.group,
        level: r.item.level,
        n: r.item.after.n,
        bias: r.item.after.bias,
        q: r.q,
      }));

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
      weakSpots,
      gaps,
      terms: full?.terms ?? [],
      baseline,
      best,
      discrimination,
      confidence,
      tier: selection.tier,
      tierNote: selection.note,
      tierCandidates: selection.candidates,
      summary,
    };
  });
