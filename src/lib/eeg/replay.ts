/**
 * Offline replay of a real EEG file through the app's own estimator.
 *
 * The point of this module is to answer one question honestly: if this
 * recording had streamed through the bedside pipeline, what would COEBIS have
 * said, and how close would it have been to the commercial monitor that was
 * actually attached at the time?
 *
 * Everything here reuses the live code path — the same 4 s analysis window,
 * the same suppression rule, the same fitted alignment — so a replay result is
 * comparable with what the monitor screen would have shown, not a
 * reimplementation that flatters the model.
 */

import { alignSeries, agreementMetrics, type AgreementMetrics, type AlignedPair, type Point } from "./agreement";
import { covariateLabel, type CaseCovariates } from "./covariates";
import { applyBisAlignment, DepthIndexEstimator, type BisAlignment } from "./depth";
import { deriveEpochsFromRaw } from "./physionet";
import {
  calibrationReport,
  localVolatility,
  predictionInterval,
  type CalibrationReport,
} from "./coebis-uncertainty";
import type { PriorGroup } from "./vitaldb";

/** One second of replayed recording, on the shared DSA time axis. */
export interface ReplayFrame {
  /** Seconds from the start of the recording (right edge of the window). */
  t: number;
  /** dB spectrum on the DSA grid (0.5–30 Hz). */
  spectrum: number[];
  /** Summed band power, µV². */
  totalPower: number;
  sef95: number;
  /** Trailing-window suppression ratio, %. */
  suppressionRatio: number;
  isSuppressed: boolean;
  /** OpenIBIS-scale index the estimator produced for this window. */
  appIndex: number | null;
  /** COEBIS prediction: the index after the fitted alignment and covariates. */
  coebis: number | null;
  /** Commercial monitor reading nearest this second, when the file has one. */
  bis: number | null;
  /** Lower bound of the COEBIS prediction interval (90% by default). */
  coebisLower: number | null;
  /** Upper bound of the COEBIS prediction interval. */
  coebisUpper: number | null;
  /** Quoted spread behind the interval, index points. */
  coebisSigma: number | null;
}

export interface ReplayCovariateRow {
  group: string;
  level: string;
  levelLabel: string;
  n: number;
  meanBis: number | null;
  meanCoebis: number | null;
  /** Mean prediction − mean monitor value for this level in this recording. */
  bias: number | null;
  /** Population mean BIS for the same level in the imported external pool. */
  priorBis: number | null;
  priorCases: number | null;
}

export interface ReplayResult {
  frames: ReplayFrame[];
  sampleRate: number;
  durationSeconds: number;
  /** COEBIS vs monitor, paired second by second. */
  pairs: AlignedPair[];
  metrics: AgreementMetrics | null;
  /** The unaligned index vs monitor, so the table shows what COEBIS added. */
  baselineMetrics: AgreementMetrics | null;
  covariates: ReplayCovariateRow[];
  /** How well the quoted intervals matched the monitor in this recording. */
  calibration: CalibrationReport | null;
  /** Nominal level the plotted band represents. */
  intervalLevel: number;
  notes: string[];
}

export interface ReplayOptions {
  samples: Float64Array | number[];
  sampleRate: number;
  /** Monitor readings from the same recording, seconds-from-start. */
  bis?: Point[];
  /** Fitted COEBIS model; omitted or null replays the raw index. */
  alignment?: BisAlignment | null;
  covariates?: CaseCovariates | null;
  /** Match tolerance when pairing monitor readings to replay seconds. */
  toleranceSeconds?: number;
  /** External-pool priors to sit alongside the per-covariate breakdown. */
  priors?: PriorGroup[];
}

const EPOCH_SECONDS = 4;
/** Nominal level of the interval drawn on the replay timeline. */
const INTERVAL_LEVEL = 0.9;

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const round = (v: number | null, dp = 1) =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

/** Replay a raw single-channel recording, one frame per second. */
export function replayRawEeg(options: ReplayOptions): ReplayResult {
  const fs = options.sampleRate;
  const samples = options.samples instanceof Float64Array
    ? options.samples
    : Float64Array.from(options.samples);
  const notes: string[] = [];

  if (!Number.isFinite(fs) || fs <= 0 || samples.length < fs * EPOCH_SECONDS) {
    return {
      frames: [],
      sampleRate: fs,
      durationSeconds: 0,
      pairs: [],
      metrics: null,
      baselineMetrics: null,
      covariates: [],
      calibration: null,
      intervalLevel: INTERVAL_LEVEL,
      notes: ["Recording is shorter than one analysis window."],
    };
  }

  // Spectral / suppression features on a 1 s hop, matching the DSA cadence.
  const epochs = deriveEpochsFromRaw(samples, fs, {
    caseRef: "replay",
    epochSeconds: EPOCH_SECONDS,
    hopSeconds: 1,
  });

  // The index itself, from the live estimator, on the same grid.
  const est = new DepthIndexEstimator();
  const windowLen = Math.max(Math.round(EPOCH_SECONDS * fs), 8);
  const hop = Math.max(1, Math.round(fs));
  const indexAt = new Map<number, number>();
  for (let end = windowLen; end <= samples.length; end += hop) {
    const win = Float64Array.from(samples.subarray(end - windowLen, end));
    const reading = est.update(win, fs, { usable: true }, 1);
    if (reading.index !== null) indexAt.set(Math.round(end / fs), reading.index);
  }

  const bisPoints = (options.bis ?? []).slice().sort((a, b) => a.t - b.t);
  const tolerance = options.toleranceSeconds ?? 5;
  const alignment = options.alignment ?? null;
  const cov = options.covariates ?? null;

  const covariatesKnown = Boolean(
    cov && (cov.ageBand || cov.sex || cov.regimen || cov.frailty),
  );

  const frames: ReplayFrame[] = epochs.map((e) => {
    // deriveEpochsFromRaw reports the window start; the index is stamped at
    // the window end, so shift onto a shared "data up to here" timeline.
    const t = Math.round(e.atSeconds + EPOCH_SECONDS);
    const appIndex = indexAt.get(t) ?? null;
    const coebis =
      appIndex == null
        ? null
        : alignment
          ? Math.round(applyBisAlignment(appIndex, alignment, cov))
          : Math.round(appIndex);
    return {
      t,
      spectrum: e.spectrumDb,
      totalPower: e.totalPower,
      sef95: e.sef95,
      suppressionRatio: e.suppressionRatio,
      isSuppressed: e.isSuppressed,
      appIndex,
      coebis,
      bis: nearest(bisPoints, t, tolerance),
      coebisLower: null,
      coebisUpper: null,
      coebisSigma: null,
    };
  });

  // Interval width needs the neighbouring seconds, so it is filled in once the
  // whole timeline exists rather than inside the per-epoch map.
  const indexTrack = frames.map((f) => f.appIndex);
  frames.forEach((f, i) => {
    const interval = predictionInterval(
      {
        prediction: f.coebis,
        reliable: f.appIndex != null,
        suppressionRatio: f.suppressionRatio,
        volatility: localVolatility(indexTrack, i),
        covariatesKnown,
      },
      alignment,
      INTERVAL_LEVEL,
    );
    if (!interval) return;
    f.coebisLower = Number(interval.lower.toFixed(1));
    f.coebisUpper = Number(interval.upper.toFixed(1));
    f.coebisSigma = Number(interval.sigma.toFixed(2));
  });

  if (!alignment) notes.push("No fitted COEBIS model — the raw index is shown unaligned.");
  if (!bisPoints.length) notes.push("No monitor readings in the file, so agreement cannot be scored.");

  const coebisSeries: Point[] = frames
    .filter((f) => f.coebis != null)
    .map((f) => ({ t: f.t, v: f.coebis as number }));
  const indexSeries: Point[] = frames
    .filter((f) => f.appIndex != null)
    .map((f) => ({ t: f.t, v: f.appIndex as number }));

  const pairs = bisPoints.length ? alignSeries(bisPoints, coebisSeries, tolerance) : [];
  const basePairs = bisPoints.length ? alignSeries(bisPoints, indexSeries, tolerance) : [];

  return {
    frames,
    sampleRate: fs,
    durationSeconds: samples.length / fs,
    pairs,
    metrics: pairs.length >= 3 ? agreementMetrics(pairs) : null,
    baselineMetrics: basePairs.length >= 3 ? agreementMetrics(basePairs) : null,
    covariates: covariateBreakdown(frames, cov, options.priors ?? []),
    calibration: bisPoints.length
      ? calibrationReport(
          frames
            .filter((f) => f.coebis != null && f.bis != null && f.coebisSigma != null)
            .map((f) => ({
              prediction: f.coebis as number,
              sigma: f.coebisSigma as number,
              actual: f.bis as number,
            })),
        )
      : null,
    intervalLevel: INTERVAL_LEVEL,
    notes,
  };
}

/** Nearest reading within `tolerance` seconds, else null. */
function nearest(points: Point[], t: number, tolerance: number): number | null {
  if (!points.length) return null;
  let best: Point | null = null;
  for (const p of points) {
    if (best === null || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    if (p.t - t > tolerance) break;
  }
  return best && Math.abs(best.t - t) <= tolerance ? best.v : null;
}

/**
 * A single recording only occupies one level of each covariate group, so the
 * breakdown is a like-for-like row against the external pool rather than a
 * within-file comparison: this patient's band, this patient's regimen, and
 * what the pool says patients like them usually read.
 */
export function covariateBreakdown(
  frames: ReplayFrame[],
  cov: CaseCovariates | null,
  priors: PriorGroup[],
): ReplayCovariateRow[] {
  if (!cov) return [];
  const scored = frames.filter((f) => f.coebis != null);
  const withBis = scored.filter((f) => f.bis != null);
  const entries: [string, string | null | undefined][] = [
    ["age", cov.ageBand],
    ["sex", cov.sex],
    ["regimen", cov.regimen],
    ["frailty", cov.frailty],
  ];

  const rows: ReplayCovariateRow[] = [];
  for (const [group, level] of entries) {
    if (!level) continue;
    const prior = priors.find((p) => p.group === group && p.level === level) ?? null;
    const meanBis = mean(withBis.map((f) => f.bis as number));
    const meanCoebis = mean(scored.map((f) => f.coebis as number));
    rows.push({
      group,
      level,
      levelLabel: covariateLabel(group, level),
      n: scored.length,
      meanBis: round(meanBis),
      meanCoebis: round(meanCoebis),
      bias:
        withBis.length && meanBis != null
          ? round((mean(withBis.map((f) => f.coebis as number)) ?? 0) - meanBis)
          : null,
      priorBis: prior ? prior.meanBis : null,
      priorCases: prior ? prior.cases : null,
    });
  }
  return rows;
}
