/**
 * Whether the paired-reading evidence behind COEBIS is actually sufficient,
 * and how well the fitted correction performs.
 *
 * The fit-quality module grades the residuals of the model that is loaded.
 * This one answers the question a clinician asks before trusting the number:
 * *what has the app checked, what passed, and what is still missing?* Each
 * check is reported individually with its own threshold, so "provisional"
 * always comes with the reason it is not yet confirmed.
 */
import {
  GAIN_LIMITS,
  MAX_OFFSET,
  MIN_MAE_GAIN,
  MIN_MEANINGFUL_BIAS,
  MIN_POINTS,
  MIN_SESSIONS,
  PROVISIONAL_MIN_POINTS,
  PROVISIONAL_MIN_SESSIONS,
  type BisDriftAnalysis,
} from "./bis-drift";

/** Residual bias (BIS units) below which the fitted model is centred. */
export const MAX_RESIDUAL_BIAS = 2;
/** Residual MAE (BIS units) at or below which agreement is treated as good. */
export const GOOD_RESIDUAL_MAE = 4;
/** Depth bands that should carry readings before a fit generalises. */
export const MIN_BANDS_COVERED = 2;
/** Divergence between the recent and overall offset that suggests movement. */
export const MAX_RECENT_DIVERGENCE = 5;

export type CheckStatus = "pass" | "partial" | "fail" | "n/a";

export interface SufficiencyCheck {
  id: string;
  /** Short name of what is being checked. */
  label: string;
  status: CheckStatus;
  /** The bar this check has to clear, in plain language. */
  requirement: string;
  /** Where the data currently stands against that bar. */
  detail: string;
}

export type CoebisTier = "none" | "provisional" | "confirmed";

/**
 * One dimension of model confidence, reported separately.
 *
 * A single blended 0–100 number invites over-trust: it lets strong evidence in
 * one dimension hide the absence of evidence in another. Each component is
 * therefore published on its own, together with an explicit statement of what
 * has *not* been established (`missing`).
 */
export interface SufficiencyComponent {
  key: string;
  label: string;
  /** 0–1 standing on this dimension, or null when it cannot be judged yet. */
  value: number | null;
  /** Plain-language reading of where the evidence stands. */
  detail: string;
  /** What this dimension does *not* tell you. */
  limitation: string;
}

export interface CoebisSufficiency {
  tier: CoebisTier;
  /**
   * Legacy blended 0–100 confidence. Retained for stored records and trend
   * comparisons only — the UI reports `components` and `missing` instead.
   * @deprecated Read `components` and `missing`.
   */
  score: number | null;
  /** Word for the score: "Weak" / "Moderate" / "Strong". */
  scoreLabel: string;
  tone: "default" | "caution" | "critical" | "signal";
  /** One-line verdict for headers and tooltips. */
  headline: string;
  /** What would move the model from provisional to confirmed, if anything. */
  nextStep: string | null;
  /** Confidence broken into its independent dimensions. */
  components: SufficiencyComponent[];
  /** Explicit list of what has not been established yet. */
  missing: string[];
  checks: SufficiencyCheck[];
  passed: number;
  failed: number;
  total: number;
}

/** Fraction of the way from `from` to `to`, clamped to 0–1. */
function ramp(value: number, from: number, to: number): number {
  if (to === from) return value >= to ? 1 : 0;
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const signed = (v: number | null | undefined, dp = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}`;

/**
 * Grade the evidence behind the COEBIS correction.
 *
 * `active` describes the correction currently in force, when there is one; the
 * checks are run against the pooled analysis either way so a clinician can see
 * how close the app is to fitting one.
 */
export function evaluateCoebisSufficiency(
  analysis: BisDriftAnalysis | null | undefined,
  active: { gain: number; offset: number; nPoints: number; maeBefore: number | null; maeAfter: number | null } | null = null,
): CoebisSufficiency {
  if (!analysis) {
    return {
      tier: "none",
      score: null,
      scoreLabel: "No data",
      tone: "critical",
      headline: "No paired commercial BIS readings have been pooled yet.",
      nextStep: `Enter paired BIS readings during cases: ${PROVISIONAL_MIN_POINTS} readings across ${PROVISIONAL_MIN_SESSIONS} cases start a provisional model.`,
      components: [],
      missing: [
        "No paired readings — nothing about this model's accuracy has been established.",
      ],
      checks: [],
      passed: 0,
      failed: 0,
      total: 0,
    };
  }

  const checks: SufficiencyCheck[] = [];
  const fit = analysis.fit;
  const n = analysis.n;
  const sessions = analysis.sessions;

  // 1. Volume of paired readings.
  checks.push({
    id: "readings",
    label: "Paired readings",
    status: n >= MIN_POINTS ? "pass" : n >= PROVISIONAL_MIN_POINTS ? "partial" : "fail",
    requirement: `${PROVISIONAL_MIN_POINTS} for a provisional model, ${MIN_POINTS} to confirm`,
    detail:
      n >= MIN_POINTS
        ? `${n} pooled — full evidence bar cleared.`
        : n >= PROVISIONAL_MIN_POINTS
          ? `${n} pooled — ${MIN_POINTS - n} more needed to confirm.`
          : `${n} pooled — ${Math.max(0, PROVISIONAL_MIN_POINTS - n)} more needed before any correction is fitted.`,
  });

  // 2. Independent cases — a single case cannot show a systematic offset.
  checks.push({
    id: "cases",
    label: "Independent cases",
    status:
      sessions >= MIN_SESSIONS ? "pass" : sessions >= PROVISIONAL_MIN_SESSIONS ? "partial" : "fail",
    requirement: `${PROVISIONAL_MIN_SESSIONS} for a provisional model, ${MIN_SESSIONS} to confirm`,
    detail:
      sessions >= MIN_SESSIONS
        ? `${plural(sessions, "case")} contributing — offset is not tied to one patient.`
        : `${plural(sessions, "case")} contributing — readings from ${Math.max(1, MIN_SESSIONS - sessions)} more case${MIN_SESSIONS - sessions === 1 ? "" : "s"} would confirm the offset generalises.`,
  });

  // 3. Reliable (signal-quality gated) share of those readings.
  const reliableShare = n ? analysis.nReliable / n : 0;
  checks.push({
    id: "reliable",
    label: "Signal quality at entry",
    status: reliableShare >= 0.7 ? "pass" : reliableShare >= 0.4 ? "partial" : "fail",
    requirement: "Most readings taken while the headband signal was reliable",
    detail: n
      ? `${analysis.nReliable} of ${n} readings (${Math.round(reliableShare * 100)}%) were logged during reliable signal.`
      : "No readings yet.",
  });

  // 4. Is there an offset worth correcting, and is it real?
  const absBias = analysis.bias == null ? null : Math.abs(analysis.bias);
  checks.push({
    id: "bias",
    label: "Offset is real and worth correcting",
    status:
      absBias == null
        ? "fail"
        : analysis.readiness.biasSignificant && absBias >= MIN_MEANINGFUL_BIAS
          ? "pass"
          : analysis.readiness.biasSignificant || absBias >= MIN_MEANINGFUL_BIAS
            ? "partial"
            : "fail",
    requirement: `95 % CI excludes zero and the offset is at least ${MIN_MEANINGFUL_BIAS} BIS units`,
    detail:
      absBias == null
        ? "No offset computed yet."
        : `Mean offset ${signed(analysis.bias)} units${
            analysis.ci ? ` (95 % CI ${analysis.ci[0].toFixed(1)} to ${analysis.ci[1].toFixed(1)})` : ""
          }; ${analysis.readiness.biasSignificant ? "the interval excludes zero" : "the interval still spans zero"}.`,
  });

  // 5. The fitted map has to stay inside physiological guard rails.
  const gain = fit?.gain ?? active?.gain ?? null;
  const offset = fit?.offset ?? active?.offset ?? null;
  const gainOk =
    gain != null && gain >= GAIN_LIMITS[0] && gain <= GAIN_LIMITS[1] && Math.abs(offset ?? 0) <= MAX_OFFSET;
  checks.push({
    id: "guardrails",
    label: "Fit inside guard rails",
    status: gain == null ? "n/a" : gainOk ? "pass" : "fail",
    requirement: `Gain ${GAIN_LIMITS[0]}–${GAIN_LIMITS[1]}, offset within ±${MAX_OFFSET}`,
    detail:
      gain == null
        ? "No candidate fit yet."
        : `Gain ${gain.toFixed(3)}, offset ${signed(offset, 1)} — ${gainOk ? "within" : "outside"} the permitted range.`,
  });

  // 6. The correction must measurably improve agreement.
  const maeBefore = fit?.maeBefore ?? active?.maeBefore ?? null;
  const maeAfter = fit?.maeAfter ?? active?.maeAfter ?? null;
  const maeGain = maeBefore != null && maeAfter != null ? maeBefore - maeAfter : null;
  checks.push({
    id: "improvement",
    label: "Correction improves agreement",
    status:
      maeGain == null ? "n/a" : maeGain >= MIN_MAE_GAIN ? "pass" : maeGain > 0 ? "partial" : "fail",
    requirement: `Removes at least ${MIN_MAE_GAIN} BIS unit of mean absolute error`,
    detail:
      maeGain == null
        ? "No candidate fit yet."
        : `Mean absolute error ${maeBefore!.toFixed(1)} → ${maeAfter!.toFixed(1)} units (${maeGain >= 0 ? "−" : "+"}${Math.abs(maeGain).toFixed(1)}).`,
  });

  // 7. Residual bias after correction — a centred model should sit near zero.
  const residualBias = fit?.biasAfter ?? null;
  checks.push({
    id: "residual",
    label: "Residuals centred",
    status:
      residualBias == null
        ? "n/a"
        : Math.abs(residualBias) <= MAX_RESIDUAL_BIAS
          ? "pass"
          : Math.abs(residualBias) <= MAX_RESIDUAL_BIAS * 2
            ? "partial"
            : "fail",
    requirement: `Residual bias within ±${MAX_RESIDUAL_BIAS} units`,
    detail:
      residualBias == null
        ? "No candidate fit yet."
        : `Residual bias ${signed(residualBias)} units after correction.`,
  });

  // 8. Depth-band coverage — a fit learned only from light planes should not
  //    be trusted at burst suppression, and vice versa.
  const covered = analysis.bands.filter((b) => b.n > 0);
  checks.push({
    id: "coverage",
    label: "Depth-band coverage",
    status:
      covered.length >= analysis.bands.length
        ? "pass"
        : covered.length >= MIN_BANDS_COVERED
          ? "partial"
          : "fail",
    requirement: `Readings from at least ${MIN_BANDS_COVERED} depth bands`,
    detail: covered.length
      ? `Readings in ${covered.map((b) => b.band).join(", ")}${
          covered.length < analysis.bands.length
            ? ` — none yet in ${analysis.bands.filter((b) => !b.n).map((b) => b.band).join(", ")}`
            : ""
        }.`
      : "No band coverage yet.",
  });

  // 9. Stability — a recent offset that has moved away from the pooled one
  //    means the model is fitting a moving target.
  const divergence =
    analysis.recent.bias != null && analysis.bias != null
      ? Math.abs(analysis.recent.bias - analysis.bias)
      : null;
  checks.push({
    id: "stability",
    label: "Offset stable over time",
    status:
      divergence == null
        ? "n/a"
        : divergence <= MAX_RECENT_DIVERGENCE
          ? "pass"
          : divergence <= MAX_RECENT_DIVERGENCE * 2
            ? "partial"
            : "fail",
    requirement: `Recent offset within ${MAX_RECENT_DIVERGENCE} units of the pooled offset`,
    detail:
      divergence == null
        ? "Not enough recent readings to judge."
        : `Last ${analysis.recent.n} readings offset ${signed(analysis.recent.bias)} vs pooled ${signed(analysis.bias)} (difference ${divergence.toFixed(1)}).`,
  });

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  const tier: CoebisTier =
    analysis.tier ??
    (n >= MIN_POINTS && sessions >= MIN_SESSIONS
      ? "confirmed"
      : analysis.readiness.provisional.met
        ? "provisional"
        : "none");

  // Weighted score: evidence volume, agreement after correction, and breadth.
  const score =
    tier === "none" && !fit
      ? null
      : Math.round(
          100 *
            (0.25 * ramp(n, PROVISIONAL_MIN_POINTS / 2, MIN_POINTS) +
              0.15 * ramp(sessions, 1, MIN_SESSIONS) +
              0.1 * reliableShare +
              0.25 *
                (maeAfter == null ? 0.4 : 1 - ramp(maeAfter, GOOD_RESIDUAL_MAE, GOOD_RESIDUAL_MAE * 3)) +
              0.1 *
                (residualBias == null
                  ? 0.4
                  : 1 - ramp(Math.abs(residualBias), MAX_RESIDUAL_BIAS, MAX_RESIDUAL_BIAS * 3)) +
              0.1 * (analysis.bands.length ? covered.length / analysis.bands.length : 0) +
              0.05 * (divergence == null ? 0.5 : 1 - ramp(divergence, 0, MAX_RECENT_DIVERGENCE * 2))),
        );

  const scoreLabel =
    score == null ? "No fit" : score >= 75 ? "Strong" : score >= 50 ? "Moderate" : "Weak";
  const tone: CoebisSufficiency["tone"] =
    score == null || score < 50 ? "critical" : score < 75 ? "caution" : "signal";

  const headline =
    tier === "confirmed"
      ? `Confirmed model — ${passed} of ${checks.length} sufficiency checks passed, confidence ${score}/100.`
      : tier === "provisional"
        ? `Provisional model — fitted on early data (${n} readings, ${plural(sessions, "case")}), confidence ${score}/100.`
        : `No model yet — ${n} paired reading${n === 1 ? "" : "s"} pooled so far.`;

  const needPoints = Math.max(0, MIN_POINTS - n);
  const needSessions = Math.max(0, MIN_SESSIONS - sessions);
  const nextStep =
    tier === "confirmed"
      ? failed
        ? "Confirmed, but the failed checks below limit how far the number should be trusted."
        : null
      : needPoints || needSessions
        ? `To confirm: ${[
            needPoints ? `${needPoints} more paired reading${needPoints === 1 ? "" : "s"}` : null,
            needSessions ? `readings from ${needSessions} more case${needSessions === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" and ")}.`
        : "All evidence thresholds met — the model confirms on the next refit.";

  return { tier, score, scoreLabel, tone, headline, nextStep, checks, passed, failed, total: checks.length };
}