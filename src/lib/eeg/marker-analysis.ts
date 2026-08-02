import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";

/** Metrics tracked either side of a user marker. */
export interface MarkerMetricDelta {
  metric: string;
  before: number | null;
  after: number | null;
  change: number | null;
}

export interface MarkerResponse {
  tSeconds: number;
  label: string;
  /** Seconds of data available before/after the marker inside the windows. */
  beforeEpochs: number;
  afterEpochs: number;
  deltas: MarkerMetricDelta[];
  /** Detected events that started within the post-marker window. */
  followedBy: { kind: string; severity: string; tSeconds: number; detail: string }[];
  /** Short plain-language summary of the dominant change. */
  summary: string;
}

/** A stretch of recording between two consecutive markers. */
export interface MarkerPhase {
  fromLabel: string;
  tStartSeconds: number;
  tEndSeconds: number;
  meanDepth: number | null;
  meanSef95: number;
  meanSuppressionPct: number;
  meanSeizureScore: number;
  meanNociception: number | null;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(v: number | null, dp = 1): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

function pick(epochs: Epoch[], key: string): number[] {
  switch (key) {
    case "depthIndex":
      return epochs.map((e) => e.depth.index).filter((v): v is number => v != null);
    case "sef95Hz":
      return epochs.map((e) => e.sef95);
    case "suppressionRatioPct":
      return epochs.map((e) => e.suppressionRatio);
    case "seizureScore":
      return epochs.map((e) => e.seizureScore);
    case "stateEntropy":
      return epochs.map((e) => e.entropy.state);
    case "nociceptionIndex":
      return epochs.map((e) => e.composite.nIndex).filter((v): v is number => v != null);
    case "consciousnessIndex":
      return epochs.map((e) => e.composite.cIndex).filter((v): v is number => v != null);
    case "totalPowerDb":
      return epochs.map((e) => 10 * Math.log10(Math.max(e.totalPower, 1e-6)));
    default:
      return [];
  }
}

const METRICS = [
  "depthIndex",
  "sef95Hz",
  "suppressionRatioPct",
  "seizureScore",
  "stateEntropy",
  "nociceptionIndex",
  "consciousnessIndex",
  "totalPowerDb",
] as const;

/** Human-readable one-liner for the biggest movers around a marker. */
function describe(deltas: MarkerMetricDelta[]): string {
  const scale: Record<string, number> = {
    depthIndex: 5,
    sef95Hz: 1.5,
    suppressionRatioPct: 5,
    seizureScore: 0.15,
    stateEntropy: 0.05,
    nociceptionIndex: 8,
    consciousnessIndex: 8,
    totalPowerDb: 3,
  };
  const notable = deltas
    .filter((d) => d.change != null && Math.abs(d.change) >= (scale[d.metric] ?? 1))
    .sort((a, b) => Math.abs(b.change! / (scale[b.metric] ?? 1)) - Math.abs(a.change! / (scale[a.metric] ?? 1)))
    .slice(0, 3);
  if (!notable.length) return "No clear change in the tracked indices around this marker.";
  return notable
    .map((d) => `${d.metric} ${d.change! > 0 ? "+" : ""}${d.change} (${d.before} → ${d.after})`)
    .join("; ");
}

export interface MarkerAnalysisOptions {
  /** Seconds of data averaged before the marker. */
  beforeSeconds?: number;
  /** Seconds of data averaged after the marker. */
  afterSeconds?: number;
}

/**
 * Cross-references user markers ("ketamine bolus", "facial twitching") against
 * the quantitative EEG trend, producing before/after deltas and the detected
 * events that followed each marker.
 */
export function analyseMarkers(
  epochs: Epoch[],
  events: DetectedEvent[],
  options: MarkerAnalysisOptions = {},
): MarkerResponse[] {
  const before = options.beforeSeconds ?? 60;
  const after = options.afterSeconds ?? 120;
  const markers = events
    .filter((e) => e.kind === "annotation")
    .sort((a, b) => a.t - b.t);

  return markers.map((m) => {
    const pre = epochs.filter((e) => e.t >= m.t - before && e.t < m.t);
    const post = epochs.filter((e) => e.t > m.t && e.t <= m.t + after);
    const deltas: MarkerMetricDelta[] = METRICS.map((metric) => {
      const b = round(mean(pick(pre, metric)), metric === "seizureScore" || metric === "stateEntropy" ? 2 : 1);
      const a = round(mean(pick(post, metric)), metric === "seizureScore" || metric === "stateEntropy" ? 2 : 1);
      return {
        metric,
        before: b,
        after: a,
        change: b != null && a != null ? round(a - b, metric === "seizureScore" || metric === "stateEntropy" ? 2 : 1) : null,
      };
    });
    const followedBy = events
      .filter((e) => e.kind !== "annotation" && e.t > m.t && e.t <= m.t + after)
      .slice(0, 5)
      .map((e) => ({
        kind: e.kind,
        severity: e.severity,
        tSeconds: Math.round(e.t),
        detail: e.detail,
      }));
    return {
      tSeconds: Math.round(m.t),
      label: m.detail,
      beforeEpochs: pre.length,
      afterEpochs: post.length,
      deltas,
      followedBy,
      summary: describe(deltas),
    };
  });
}

/** Segments the session by markers so the model can reason phase by phase. */
export function buildMarkerPhases(epochs: Epoch[], events: DetectedEvent[]): MarkerPhase[] {
  const markers = events.filter((e) => e.kind === "annotation").sort((a, b) => a.t - b.t);
  if (!epochs.length) return [];
  const bounds = [0, ...markers.map((m) => m.t), epochs[epochs.length - 1]!.t];
  const labels = ["session start", ...markers.map((m) => m.detail)];
  const phases: MarkerPhase[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    const seg = epochs.filter((e) => e.t >= start && e.t < end);
    if (seg.length < 2) continue;
    phases.push({
      fromLabel: labels[i] ?? "segment",
      tStartSeconds: Math.round(start),
      tEndSeconds: Math.round(end),
      meanDepth: round(mean(pick(seg, "depthIndex")), 0),
      meanSef95: round(mean(pick(seg, "sef95Hz")), 1) ?? 0,
      meanSuppressionPct: round(mean(pick(seg, "suppressionRatioPct")), 1) ?? 0,
      meanSeizureScore: round(mean(pick(seg, "seizureScore")), 2) ?? 0,
      meanNociception: round(mean(pick(seg, "nociceptionIndex")), 0),
    });
  }
  return phases.slice(-12);
}
