import type { Epoch } from "@/lib/eeg/analysis";

const PREFS_KEY = "cortextrace.seizureTrendAlert";

/** Clinician-configurable thresholds for the seizure-risk trend alert. */
export interface SeizureTrendPrefs {
  /** Master switch for trend alerting. */
  enabled: boolean;
  /** Ask the AI to interpret each crossing (visual alert still fires without it). */
  aiEnabled: boolean;
  /** Smoothed seizure-risk score (0–1) that counts as "elevated". */
  riskThreshold: number;
  /** Seconds the smoothed risk must stay above threshold before alerting. */
  dwellSeconds: number;
  /** Rise in smoothed risk per minute that triggers an escalation alert. */
  riseThreshold: number;
  /** Trailing window (seconds) over which the trend and rise are computed. */
  trendWindowSeconds: number;
  /** Minimum epoch signal quality (0–1) for an epoch to count toward the trend. */
  minQuality: number;
  /** Minimum seconds between AI assessments, to limit chatter and cost. */
  cooldownSeconds: number;
}

export const DEFAULT_SEIZURE_TREND: SeizureTrendPrefs = {
  enabled: true,
  aiEnabled: true,
  riskThreshold: 0.45,
  dwellSeconds: 30,
  riseThreshold: 0.2,
  trendWindowSeconds: 180,
  minQuality: 0.4,
  cooldownSeconds: 180,
};

/** Risk must fall this far below threshold before the alert re-arms. */
export const RISK_HYSTERESIS = 0.06;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function num(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

export function loadSeizureTrendPrefs(): SeizureTrendPrefs {
  if (typeof window === "undefined") return DEFAULT_SEIZURE_TREND;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_SEIZURE_TREND;
    const p = JSON.parse(raw) as Partial<SeizureTrendPrefs>;
    return {
      enabled: p.enabled ?? DEFAULT_SEIZURE_TREND.enabled,
      aiEnabled: p.aiEnabled ?? DEFAULT_SEIZURE_TREND.aiEnabled,
      riskThreshold: num(p.riskThreshold, DEFAULT_SEIZURE_TREND.riskThreshold, 0.1, 0.95),
      dwellSeconds: num(p.dwellSeconds, DEFAULT_SEIZURE_TREND.dwellSeconds, 0, 600),
      riseThreshold: num(p.riseThreshold, DEFAULT_SEIZURE_TREND.riseThreshold, 0.02, 1),
      trendWindowSeconds: num(
        p.trendWindowSeconds,
        DEFAULT_SEIZURE_TREND.trendWindowSeconds,
        30,
        1800,
      ),
      minQuality: num(p.minQuality, DEFAULT_SEIZURE_TREND.minQuality, 0, 0.95),
      cooldownSeconds: num(p.cooldownSeconds, DEFAULT_SEIZURE_TREND.cooldownSeconds, 30, 1800),
    };
  } catch {
    return DEFAULT_SEIZURE_TREND;
  }
}

export function saveSeizureTrendPrefs(prefs: SeizureTrendPrefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}

/** Where the seizure-risk trend currently sits relative to the thresholds. */
export type SeizureTrendStatus = "unknown" | "low" | "watch" | "elevated";

export interface SeizureTrendState {
  status: SeizureTrendStatus;
  /** Exponentially smoothed seizure risk over the trend window (0–1). */
  risk: number;
  /** Raw latest epoch score (0–1). */
  latest: number;
  /** Change in smoothed risk per minute across the window (can be negative). */
  risePerMinute: number;
  /** Share of usable epochs in the window that sat above the risk threshold. */
  aboveFraction: number;
  /** Peak smoothed risk in the window. */
  peak: number;
  /** Mean epoch signal quality over the window (0–1). */
  quality: number;
  /** Mean seizure-metric confidence over the window (0–1). */
  confidence: number;
  /** Mean EMG contamination over the window (0–1). */
  emg: number;
  /** Usable epochs contributing to the trend. */
  samples: number;
  /** Seconds the smoothed risk has been continuously above threshold. */
  aboveSeconds: number;
  /** Session seconds of the latest usable epoch. */
  t: number;
  /** Smoothed risk trace for sparkline display, oldest first. */
  trace: { t: number; risk: number }[];
}

export const EMPTY_TREND: SeizureTrendState = {
  status: "unknown",
  risk: 0,
  latest: 0,
  risePerMinute: 0,
  aboveFraction: 0,
  peak: 0,
  quality: 0,
  confidence: 0,
  emg: 0,
  samples: 0,
  aboveSeconds: 0,
  t: 0,
  trace: [],
};

/**
 * Smoothed seizure-risk trend over the trailing window, with the rate of rise
 * and the time already spent above the clinician's risk threshold. Epochs
 * below the quality floor are ignored so EMG bursts don't drive the trend.
 */
export function computeSeizureTrend(epochs: Epoch[], prefs: SeizureTrendPrefs): SeizureTrendState {
  if (!epochs.length) return EMPTY_TREND;
  const last = epochs[epochs.length - 1]!;
  const from = last.t - prefs.trendWindowSeconds;
  const usable = epochs.filter((e) => e.t >= from && !e.gapAffected && e.quality.score >= prefs.minQuality);
  if (usable.length < 2) return { ...EMPTY_TREND, latest: last.seizureScore, t: last.t };

  // Exponential smoothing keeps single noisy epochs from tripping the alert
  // while still reacting within a couple of epochs to a genuine escalation.
  const alpha = 0.3;
  let smooth = usable[0]!.seizureScore;
  const trace: { t: number; risk: number }[] = [];
  let peak = 0;
  let above = 0;
  let aboveSince: number | null = null;
  let aboveSeconds = 0;
  for (const e of usable) {
    smooth = alpha * e.seizureScore + (1 - alpha) * smooth;
    trace.push({ t: e.t, risk: smooth });
    peak = Math.max(peak, smooth);
    if (smooth >= prefs.riskThreshold) {
      above++;
      aboveSince ??= e.t;
      aboveSeconds = e.t - aboveSince;
    } else if (smooth < prefs.riskThreshold - RISK_HYSTERESIS) {
      aboveSince = null;
      aboveSeconds = 0;
    }
  }

  // Rate of rise: least-squares slope of the smoothed trace, per minute.
  const n = trace.length;
  const meanT = trace.reduce((a, p) => a + p.t, 0) / n;
  const meanR = trace.reduce((a, p) => a + p.risk, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of trace) {
    sxy += (p.t - meanT) * (p.risk - meanR);
    sxx += (p.t - meanT) ** 2;
  }
  const risePerMinute = sxx > 0 ? (sxy / sxx) * 60 : 0;

  const quality = usable.reduce((a, e) => a + e.quality.score, 0) / n;
  const confidence = usable.reduce((a, e) => a + e.confidence.seizure, 0) / n;
  const emg = usable.reduce((a, e) => a + e.quality.emgIndex, 0) / n;
  const status: SeizureTrendStatus =
    smooth >= prefs.riskThreshold
      ? "elevated"
      : smooth >= prefs.riskThreshold - RISK_HYSTERESIS || risePerMinute >= prefs.riseThreshold
        ? "watch"
        : "low";

  return {
    status,
    risk: smooth,
    latest: last.seizureScore,
    risePerMinute,
    aboveFraction: above / n,
    peak,
    quality,
    confidence,
    emg,
    samples: n,
    aboveSeconds,
    t: last.t,
    trace: trace.slice(-120),
  };
}

/** Why a trend alert fired. */
export type SeizureTrendTrigger = "sustained" | "rising";

/** Compact numeric digest handed to the AI for a real-time read. */
export function buildTrendDigest(options: {
  trigger: SeizureTrendTrigger;
  trend: SeizureTrendState;
  prefs: SeizureTrendPrefs;
  epochs: Epoch[];
  mode: string;
  markers: { t: number; detail: string }[];
}) {
  const { trend, prefs, epochs } = options;
  const recent = epochs.slice(-Math.max(4, Math.round(prefs.trendWindowSeconds / 2)));
  const mean = (pick: (e: Epoch) => number) =>
    recent.length
      ? Number((recent.reduce((a, e) => a + pick(e), 0) / recent.length).toFixed(3))
      : null;
  return {
    trigger: options.trigger,
    mode: options.mode,
    tSeconds: Math.round(trend.t),
    thresholds: {
      risk: prefs.riskThreshold,
      dwellSeconds: prefs.dwellSeconds,
      risePerMinute: prefs.riseThreshold,
      trendWindowSeconds: prefs.trendWindowSeconds,
      minQuality: prefs.minQuality,
    },
    seizureTrend: {
      smoothedRisk: Number(trend.risk.toFixed(3)),
      latestScore: Number(trend.latest.toFixed(3)),
      peak: Number(trend.peak.toFixed(3)),
      risePerMinute: Number(trend.risePerMinute.toFixed(3)),
      fractionAboveThreshold: Number(trend.aboveFraction.toFixed(3)),
      secondsAboveThreshold: Math.round(trend.aboveSeconds),
      epochs: trend.samples,
    },
    signal: {
      meanQuality: Number(trend.quality.toFixed(3)),
      meanSeizureConfidence: Number(trend.confidence.toFixed(3)),
      meanEmgIndex: Number(trend.emg.toFixed(3)),
    },
    context: {
      sef95: mean((e) => e.sef95),
      suppressionRatio: mean((e) => e.suppressionRatio),
      depthIndex: mean((e) => e.depth.index ?? 0),
      stateEntropy: mean((e) => e.entropy.state),
      deltaAlphaRatio: mean((e) => e.ratios.deltaAlpha),
      totalPower: mean((e) => e.totalPower),
      amplitudeUv: mean((e) => e.amplitudeUv),
    },
    recentMarkers: options.markers
      .filter((m) => m.t >= trend.t - prefs.trendWindowSeconds * 2)
      .slice(-8)
      .map((m) => ({ tSeconds: Math.round(m.t), detail: m.detail })),
  };
}
