/**
 * Contemporaneous readings from a commercial BIS monitor running alongside the
 * Muse 2.
 *
 * The app never computes BIS — it is a proprietary index. What we capture is
 * the clinician's timestamped transcription of what the commercial monitor is
 * displaying, so that the app's OpenIBIS-style depth index (and its suppression
 * ratio) can be compared against a clinical reference, and so the AI can use
 * the paired values to comment on where the open model tracks or diverges.
 */

import type { Epoch } from "@/lib/eeg/analysis";
import { agreementMetrics, type AgreementMetrics, type AlignedPair } from "@/lib/eeg/agreement";
import {
  classifyStability,
  estimateMonitorLagSeconds,
  laggedAppIndex,
  slopePerMinute,
  type IndexSample,
  type PairStability,
} from "@/lib/eeg/pairing-lag";

/** One transcribed reading from the commercial monitor. */
export interface BisReading {
  id: string;
  /** Case-clock seconds at which the value was read off the monitor. */
  at: number;
  /** Displayed BIS index (0–100). */
  bis: number;
  /** Displayed suppression ratio (%), when shown. */
  sr?: number | null;
  /** Displayed spectral edge frequency, SEF95 (Hz), when shown. */
  sef?: number | null;
  /** Displayed EMG (dB), when shown. */
  emg?: number | null;
  /** Displayed signal quality index (%), when shown. */
  sqi?: number | null;
  /** Device the value came from, e.g. "BIS VISTA". */
  device?: string;
  note?: string;
}

export const BIS_DEVICES = [
  "BIS VISTA",
  "BIS Advance",
  "BIS Complete (Philips)",
  "BIS module (GE)",
  "Other BIS monitor",
] as const;

/** Depth bands used to check agreement where it clinically matters. */
export const BIS_BANDS = [
  { key: "deep", label: "Deep (<40)", low: -1, high: 40 },
  { key: "surgical", label: "Surgical (40–60)", low: 40, high: 60 },
  { key: "light", label: "Light (>60)", low: 60, high: 101 },
] as const;

export function clampBis(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function bisBandLabel(bis: number): string {
  return BIS_BANDS.find((b) => bis >= b.low && bis < b.high)?.label ?? "—";
}

function round(v: number | null, dp = 1): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Epoch nearest a reading, within `tolerance` seconds. */
export function nearestEpoch(epochs: Epoch[], at: number, tolerance = 30): Epoch | null {
  let best: Epoch | null = null;
  let bestGap = Infinity;
  for (const e of epochs) {
    const gap = Math.abs(e.t - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = e;
    }
  }
  return best && bestGap <= tolerance ? best : null;
}

/** A BIS reading paired with the app's own values at the same moment. */
export interface BisPairedPoint {
  at: number;
  bis: number;
  bisSr: number | null;
  /** SEF transcribed from the commercial monitor (Hz). */
  bisSef: number | null;
  depthIndex: number | null;
  /** Depth index minus BIS (positive = app reads lighter). */
  difference: number | null;
  appSr: number | null;
  srDifference: number | null;
  sef95: number | null;
  /** Headband SEF before the fitted commercial alignment — used for refits. */
  sef95Raw: number | null;
  /** App SEF95 minus commercial SEF (Hz). */
  sefDifference: number | null;
  /** App's own reliability verdict at that moment. */
  reliable: boolean;
  sqi: number | null;
  /**
   * The depth index's stated confidence, 0–1, at that moment. Filed so the
   * reliability cut-offs can be checked against how often the index actually
   * agreed with the monitor.
   */
  depthConfidence: number | null;
  gapSeconds: number | null;
  /**
   * Whether depth was steady or moving when the reading was transcribed. A
   * reading taken mid-transition carries a timing error rather than a real
   * calibration offset, so downstream fits weight it less.
   */
  stability?: PairStability;
  /** Seconds of monitor smoothing delay allowed for when pairing. */
  lagSeconds?: number;
}

export interface BisBandAgreement {
  band: string;
  n: number;
  bias: number | null;
  meanAbsolute: number | null;
}

export interface BisCalibrationSuggestion {
  /** BIS ≈ gain × depthIndex + offset (ordinary least squares). */
  gain: number;
  offset: number;
  /** Mean absolute error before and after applying the fit. */
  maeBefore: number;
  maeAfter: number;
  n: number;
}

export interface BisComparisonDigest {
  readings: number;
  paired: number;
  /** Readings the app could not pair with an epoch (no EEG at that moment). */
  unpaired: number;
  durationSeconds: number;
  devices: string[];
  metrics: AgreementMetrics | null;
  bands: BisBandAgreement[];
  suppression: {
    n: number;
    bias: number | null;
    meanAbsolute: number | null;
  };
  /** Agreement between the app's SEF95 and the monitor's displayed SEF. */
  sef: {
    n: number;
    bias: number | null;
    meanAbsolute: number | null;
  };
  /** Points where the two indices disagreed by more than 10. */
  divergences: {
    tSeconds: number;
    bis: number;
    depthIndex: number;
    difference: number;
    reliable: boolean;
    sqi: number | null;
    /** Whether depth was steady or moving when the reading was taken. */
    stability?: PairStability;
    note?: string;
  }[];
  /**
   * How the readings were time-aligned with the app index, and how many were
   * taken while depth was moving — shown so a reader can see what assumption
   * the comparison rests on.
   */
  pairing: {
    lagSeconds: number;
    stable: number;
    transitional: number;
    unknown: number;
    summary: string;
  };
  calibration: BisCalibrationSuggestion | null;
  points: BisPairedPoint[];
  sparse: boolean;
}

/** Pair every reading with the app's contemporaneous epoch. */
export function pairBisReadings(
  epochs: Epoch[],
  readings: BisReading[],
  tolerance = 30,
): BisPairedPoint[] {
  const sortedReadings = [...readings].sort((a, b) => a.at - b.at);
  /**
   * The monitor's displayed number reflects the last 15–30 s of EEG, so the
   * honest comparison is against the app index as it was then, not now. The
   * shift is estimated from the case's own readings where there are enough of
   * them, and falls back to the published delay otherwise.
   */
  const series: IndexSample[] = epochs
    .filter((e) => e.depth.index != null && Number.isFinite(e.depth.index))
    .map((e) => ({ t: e.t, value: e.depth.index as number }));
  // Only shift when the case's own readings supported the estimate. Applying
  // the published default on faith would move every pair on an assumption,
  // which is a worse error than leaving them as transcribed.
  const estimate = series.length
    ? estimateMonitorLagSeconds(sortedReadings.map((r) => ({ at: r.at, bis: r.bis, series })))
    : null;
  const lag = estimate?.estimated ? estimate.lagSeconds : 0;

  return sortedReadings
    .map((r) => {
      const epoch = nearestEpoch(epochs, r.at, tolerance);
      const nearestIndex = epoch?.depth.index ?? null;
      const depthIndex =
        nearestIndex == null || !series.length
          ? nearestIndex
          : laggedAppIndex(series, r.at, lag, nearestIndex);
      const appSr = epoch ? epoch.suppressionRatio : null;
      const appSef = epoch?.sef95 ?? null;
      const appSefRaw = epoch?.sef95Raw ?? null;
      return {
        at: r.at,
        bis: r.bis,
        bisSr: r.sr ?? null,
        bisSef: r.sef ?? null,
        depthIndex: round(depthIndex, 0),
        difference: depthIndex == null ? null : round(depthIndex - r.bis, 0),
        appSr: round(appSr, 1),
        srDifference:
          appSr == null || r.sr == null || !Number.isFinite(r.sr) ? null : round(appSr - r.sr, 1),
        sef95: round(appSef, 1),
        sef95Raw: round(appSefRaw, 2),
        sefDifference:
          appSef == null || r.sef == null || !Number.isFinite(r.sef)
            ? null
            : round(appSef - r.sef, 1),
        reliable: epoch ? epoch.depthReliability.reliable && !epoch.depth.held : false,
        sqi: round(epoch ? epoch.quality.score * 100 : null, 0),
        depthConfidence: round(epoch ? epoch.confidence.depth : null, 3),
        gapSeconds: epoch ? Math.round(Math.abs(epoch.t - r.at)) : null,
        stability: series.length
          ? classifyStability(slopePerMinute(series, r.at - lag))
          : "unknown",
        lagSeconds: lag,
      } satisfies BisPairedPoint;
    });
}

function fitCalibration(pairs: AlignedPair[]): BisCalibrationSuggestion | null {
  if (pairs.length < 5) return null;
  const xs = pairs.map((p) => p.test); // app depth index
  const ys = pairs.map((p) => p.reference); // BIS
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  if (sxx < 1e-6) return null;
  const gain = sxy / sxx;
  const offset = my - gain * mx;
  const maeBefore = mean(xs.map((x, i) => Math.abs(x - ys[i]!)))!;
  const maeAfter = mean(xs.map((x, i) => Math.abs(gain * x + offset - ys[i]!)))!;
  return {
    gain: Number(gain.toFixed(3)),
    offset: Number(offset.toFixed(2)),
    maeBefore: Number(maeBefore.toFixed(1)),
    maeAfter: Number(maeAfter.toFixed(1)),
    n: pairs.length,
  };
}

/**
 * Builds the whole-case comparison between the commercial BIS readings and the
 * app's own depth index and suppression ratio, plus a digest the AI can read.
 */
export function buildBisComparison(
  epochs: Epoch[],
  readings: BisReading[],
  elapsed: number,
  tolerance = 30,
): BisComparisonDigest {
  const points = pairBisReadings(epochs, readings, tolerance);
  const usable = points.filter((p) => p.depthIndex != null);
  const pairs: AlignedPair[] = usable.map((p) => ({
    t: p.at,
    reference: p.bis,
    test: p.depthIndex!,
  }));

  const metrics = pairs.length >= 3 ? agreementMetrics(pairs) : null;

  const bands: BisBandAgreement[] = BIS_BANDS.map((b) => {
    const inBand = usable.filter((p) => p.bis >= b.low && p.bis < b.high);
    const diffs = inBand.map((p) => p.difference!).filter((d) => Number.isFinite(d));
    return {
      band: b.label,
      n: inBand.length,
      bias: round(mean(diffs)),
      meanAbsolute: round(mean(diffs.map(Math.abs))),
    };
  });

  const srPairs = points.filter((p) => p.srDifference != null);
  const suppression = {
    n: srPairs.length,
    bias: round(mean(srPairs.map((p) => p.srDifference!))),
    meanAbsolute: round(mean(srPairs.map((p) => Math.abs(p.srDifference!)))),
  };

  const sefPairs = points.filter((p) => p.sefDifference != null);
  const sef = {
    n: sefPairs.length,
    bias: round(mean(sefPairs.map((p) => p.sefDifference!))),
    meanAbsolute: round(mean(sefPairs.map((p) => Math.abs(p.sefDifference!)))),
  };

  const noteFor = new Map(readings.map((r) => [Math.round(r.at), r.note]));
  const divergences = usable
    .filter((p) => Math.abs(p.difference!) > 10)
    .sort((a, b) => Math.abs(b.difference!) - Math.abs(a.difference!))
    .slice(0, 8)
    .map((p) => ({
      tSeconds: Math.round(p.at),
      bis: p.bis,
      depthIndex: p.depthIndex!,
      difference: p.difference!,
      reliable: p.reliable,
      sqi: p.sqi,
      ...(noteFor.get(Math.round(p.at)) ? { note: noteFor.get(Math.round(p.at))! } : {}),
    }));

  const devices = Array.from(
    new Set(readings.map((r) => r.device).filter((d): d is string => Boolean(d))),
  );

  return {
    readings: readings.length,
    paired: usable.length,
    unpaired: points.length - usable.length,
    durationSeconds: Math.round(elapsed),
    devices,
    metrics,
    bands,
    suppression,
    sef,
    divergences,
    calibration: fitCalibration(pairs),
    points: usable.slice(-60),
    sparse: usable.length < 5,
  };
}

/** One-line summary for handover strips and AI context. */
export function summariseBis(readings: BisReading[]): string {
  if (!readings.length) return "No BIS reference entered";
  const last = [...readings].sort((a, b) => a.at - b.at)[readings.length - 1]!;
  return `${readings.length} reading${readings.length === 1 ? "" : "s"} — last BIS ${last.bis}${
    last.sr != null ? ` (SR ${last.sr} %)` : ""
  }${last.sef != null ? ` (SEF ${last.sef} Hz)` : ""}`;
}
