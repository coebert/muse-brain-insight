import { analysable } from "./gaps";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";
import {
  analyseMarkers,
  buildMarkerPhases,
  type MarkerPhase,
  type MarkerResponse,
} from "@/lib/eeg/marker-analysis";

export interface PatientContext {
  ageYears: string;
  sex: string;
  admissionDiagnosis: string;
  clinicalFeatures: string[];
  context: string;
  notes: string;
  /** Free-text case summary written by the clinician, if any. */
  caseSummary?: string;
}

export interface FeatureDigest {
  mode: string;
  durationSeconds: number;
  epochCount: number;
  /** Epochs discarded because they straddle a data gap. */
  excludedGapEpochs: number;
  patient: {
    ageYears: number | null;
    sex: string | null;
    admissionDiagnosis: string | null;
    clinicalFeatures: string[];
    clinicalContext: string;
    notes: string | null;
    /** Clinician's free-text case summary, for narrative context. */
    caseSummary: string | null;
  };
  suppression: {
    meanRatioPct: number;
    maxRatioPct: number;
    suppressionSeconds: number;
    longestSuppressionSeconds: number;
    burstSuppressionEvents: number;
    isoelectricEvents: number;
  };
  seizure: {
    alerts: number;
    meanScore: number;
    maxScore: number;
    fractionAboveHalf: number;
  };
  spectral: {
    meanSef95Hz: number;
    sef95TrendHzPerHour: number;
    meanRelativeBandPower: Record<string, number>;
    bandPowerFirstThird: Record<string, number>;
    bandPowerLastThird: Record<string, number>;
    meanTotalPowerDb: number;
    alphaDeltaRatio: number;
    spectralVariability: number;
    /** Mean normalised Shannon entropy variants of the PSD (0-1). */
    meanStateEntropy: number;
    meanResponseEntropy: number;
    meanSe95Entropy: number;
    entropyTrendPerHour: number;
    /** Mean power ratios. */
    meanDeltaAlphaRatio: number;
    meanBetaAlphaRatio: number;
    meanThetaAlphaRatio: number;
  };
  quality: {
    meanScore: number;
    usableFraction: number;
    poorEpochs: number;
  };
  /** OpenIBIS-style BIS-like depth index (uncalibrated, frontal montage). */
  depthIndex: {
    mean: number | null;
    min: number | null;
    max: number | null;
    latest: number | null;
    fractionBelow40: number;
    /** Fraction of epochs where the depth index was trustworthy (0-1). */
    reliableFraction: number;
    /** Mean 0-1 confidence in the depth index across the session. */
    meanConfidence: number;
    /** Mean of the depth index restricted to reliable epochs. */
    meanWhenReliable: number | null;
    /** Latest depth index from a reliable epoch. */
    latestReliable: number | null;
    /** Whether the most recent epoch's depth index was reliable. */
    latestIsReliable: boolean;
    /** Most common reasons the depth index was gated, with counts. */
    topGatingReasons: { reason: string; epochs: number }[];
  };
  /** qCON/qNOX-style composite indices (transparent re-implementation). */
  compositeIndex: {
    meanConsciousness: number | null;
    latestConsciousness: number | null;
    meanNociception: number | null;
    latestNociception: number | null;
    fractionNociceptionAbove60: number;
  };
  annotations: { tSeconds: number; label: string }[];
  /** Before/after index changes around each user marker. */
  markerResponses: MarkerResponse[];
  /** Session segmented by markers, with mean indices per phase. */
  markerPhases: MarkerPhase[];
  /** Automatically detected events (suppression, seizure, trend alerts). */
  detectedEvents: { tSeconds: number; kind: string; severity: string; detail: string }[];
  timeline: { tSeconds: number; srPct: number; sef95: number; seizureScore: number }[];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function round(v: number, dp = 2): number {
  return Number.isFinite(v) ? Number(v.toFixed(dp)) : 0;
}

function relativeBands(epochs: Epoch[]): Record<string, number> {
  const keys = ["delta", "theta", "alpha", "beta", "gamma"] as const;
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = round(
      mean(
        epochs.map((e) => {
          const total =
            e.bands.delta + e.bands.theta + e.bands.alpha + e.bands.beta + e.bands.gamma;
          return total > 0 ? e.bands[k] / total : 0;
        }),
      ) * 100,
      1,
    );
  }
  return out;
}

/** Least-squares slope of y over t (per second). */
function slope(points: { t: number; y: number }[]): number {
  if (points.length < 3) return 0;
  const mt = mean(points.map((p) => p.t));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - mt) * (p.y - my);
    den += (p.t - mt) ** 2;
  }
  return den ? num / den : 0;
}

/** Evenly sample a trend line so the model sees the session shape, not every epoch. */
function sampleTimeline(epochs: Epoch[], points = 40) {
  if (!epochs.length) return [];
  const step = Math.max(1, Math.floor(epochs.length / points));
  const out: FeatureDigest["timeline"] = [];
  for (let i = 0; i < epochs.length; i += step) {
    const e = epochs[i]!;
    out.push({
      tSeconds: round(e.t, 0),
      srPct: round(e.suppressionRatio, 1),
      sef95: round(e.sef95, 1),
      seizureScore: round(e.seizureScore, 2),
    });
  }
  return out;
}

/**
 * Condenses a monitoring session into a compact, quantitative digest the model
 * can reason over — no raw waveform, no identifiers.
 */
export function buildFeatureDigest(
  epochs: Epoch[],
  events: DetectedEvent[],
  patient: PatientContext,
  elapsed: number,
  mode: string,
): FeatureDigest {
  // Seconds lost to a dropped headband are excluded from every aggregate.
  const gapEpochs = epochs.filter((e) => e.gapAffected).length;
  epochs = analysable(epochs);
  const third = Math.max(1, Math.floor(epochs.length / 3));
  const first = epochs.slice(0, third);
  const last = epochs.slice(-third);
  const suppressionEvents = events.filter((e) => e.kind === "burst_suppression");
  const sefs = epochs.map((e) => e.sef95);
  const rel = relativeBands(epochs);
  const age = patient.ageYears.trim() === "" ? null : Number(patient.ageYears);

  return {
    mode,
    durationSeconds: round(elapsed, 0),
    epochCount: epochs.length,
    excludedGapEpochs: gapEpochs,
    patient: {
      ageYears: age !== null && Number.isFinite(age) ? Math.round(age) : null,
      sex: patient.sex || null,
      admissionDiagnosis: patient.admissionDiagnosis.trim() || null,
      clinicalFeatures: patient.clinicalFeatures,
      clinicalContext: patient.context,
      notes: patient.notes.trim() || null,
      caseSummary: (patient.caseSummary ?? "").trim() || null,
    },
    suppression: {
      meanRatioPct: round(mean(epochs.map((e) => e.suppressionRatio)), 1),
      maxRatioPct: round(Math.max(0, ...epochs.map((e) => e.suppressionRatio)), 1),
      // Summed over analysed epochs (1 s hop) so gap seconds add nothing.
      suppressionSeconds: round(
        epochs.reduce((a, e) => a + e.epochSuppression, 0),
        1,
      ),
      longestSuppressionSeconds: round(Math.max(0, ...suppressionEvents.map((e) => e.duration)), 1),
      burstSuppressionEvents: suppressionEvents.length,
      isoelectricEvents: events.filter((e) => e.kind === "isoelectric").length,
    },
    seizure: {
      alerts: events.filter((e) => e.kind === "seizure").length,
      meanScore: round(mean(epochs.map((e) => e.seizureScore))),
      maxScore: round(Math.max(0, ...epochs.map((e) => e.seizureScore))),
      fractionAboveHalf: round(
        epochs.length ? epochs.filter((e) => e.seizureScore > 0.5).length / epochs.length : 0,
      ),
    },
    spectral: {
      meanSef95Hz: round(mean(sefs), 1),
      sef95TrendHzPerHour: round(slope(epochs.map((e) => ({ t: e.t, y: e.sef95 }))) * 3600, 1),
      meanRelativeBandPower: rel,
      bandPowerFirstThird: relativeBands(first),
      bandPowerLastThird: relativeBands(last),
      meanTotalPowerDb: round(
        mean(epochs.map((e) => 10 * Math.log10(Math.max(e.totalPower, 1e-6)))),
        1,
      ),
      alphaDeltaRatio: round((rel["alpha"] ?? 0) / Math.max(rel["delta"] ?? 0, 0.01)),
      spectralVariability: round(Math.sqrt(mean(sefs.map((v) => (v - mean(sefs)) ** 2))), 2),
      meanStateEntropy: round(mean(epochs.map((e) => e.entropy.state))),
      meanResponseEntropy: round(mean(epochs.map((e) => e.entropy.response))),
      meanSe95Entropy: round(mean(epochs.map((e) => e.entropy.se95))),
      entropyTrendPerHour: round(
        slope(epochs.map((e) => ({ t: e.t, y: e.entropy.state }))) * 3600,
        2,
      ),
      meanDeltaAlphaRatio: round(mean(epochs.map((e) => e.ratios.deltaAlpha))),
      meanBetaAlphaRatio: round(mean(epochs.map((e) => e.ratios.betaAlpha))),
      meanThetaAlphaRatio: round(mean(epochs.map((e) => e.ratios.thetaAlpha))),
    },
    quality: {
      meanScore: round(mean(epochs.map((e) => e.quality.score))),
      usableFraction: round(
        epochs.length ? epochs.filter((e) => e.quality.grade !== "poor").length / epochs.length : 0,
      ),
      poorEpochs: epochs.filter((e) => e.quality.grade === "poor").length,
    },
    depthIndex: (() => {
      const vals = epochs.map((e) => e.depth.index).filter((v): v is number => v != null);
      const reliableEpochs = epochs.filter((e) => e.depthReliability.reliable);
      const reliableVals = reliableEpochs
        .map((e) => e.depth.index)
        .filter((v): v is number => v != null);
      const reasonCounts = new Map<string, number>();
      for (const e of epochs) {
        if (e.depthReliability.reliable) continue;
        for (const r of e.depthReliability.reasons) {
          // Strip epoch-specific numbers so reasons aggregate.
          const key = r.replace(/\d+(\.\d+)?/g, "N");
          reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
        }
      }
      const topGatingReasons = [...reasonCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([reason, count]) => ({ reason, epochs: count }));
      const reliability = {
        reliableFraction: round(epochs.length ? reliableEpochs.length / epochs.length : 0),
        meanConfidence: round(mean(epochs.map((e) => e.confidence.depth))),
        meanWhenReliable: reliableVals.length ? round(mean(reliableVals), 0) : null,
        latestReliable: reliableVals.length ? reliableVals[reliableVals.length - 1]! : null,
        latestIsReliable: epochs.length
          ? epochs[epochs.length - 1]!.depthReliability.reliable
          : false,
        topGatingReasons,
      };
      if (!vals.length) {
        return {
          mean: null,
          min: null,
          max: null,
          latest: null,
          fractionBelow40: 0,
          ...reliability,
        };
      }
      return {
        mean: round(mean(vals), 0),
        min: Math.min(...vals),
        max: Math.max(...vals),
        latest: vals[vals.length - 1]!,
        fractionBelow40: round(vals.filter((v) => v < 40).length / vals.length),
        ...reliability,
      };
    })(),
    compositeIndex: (() => {
      const c = epochs.map((e) => e.composite.cIndex).filter((v): v is number => v != null);
      const n = epochs.map((e) => e.composite.nIndex).filter((v): v is number => v != null);
      return {
        meanConsciousness: c.length ? round(mean(c), 0) : null,
        latestConsciousness: c.length ? c[c.length - 1]! : null,
        meanNociception: n.length ? round(mean(n), 0) : null,
        latestNociception: n.length ? n[n.length - 1]! : null,
        fractionNociceptionAbove60: n.length
          ? round(n.filter((v) => v >= 60).length / n.length)
          : 0,
      };
    })(),
    annotations: events
      .filter((e) => e.kind === "annotation")
      .map((e) => ({ tSeconds: round(e.t, 0), label: e.detail })),
    markerResponses: analyseMarkers(epochs, events),
    markerPhases: buildMarkerPhases(epochs, events),
    detectedEvents: events
      .filter((e) => e.kind !== "annotation")
      .slice(-25)
      .map((e) => ({
        tSeconds: round(e.t, 0),
        kind: e.kind,
        severity: e.severity,
        detail: e.detail,
      })),
    timeline: sampleTimeline(epochs),
  };
}
