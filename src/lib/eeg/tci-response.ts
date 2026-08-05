import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";
import { pearson } from "@/lib/eeg/correlation";
import { ceHistory, tciModel, type TciInfusion } from "@/lib/eeg/tci";

/** Seconds of EEG averaged either side of a Ce change. */
const BEFORE_WINDOW = 90;
const AFTER_WINDOW = 240;

export interface TciMetricDelta {
  metric: string;
  before: number | null;
  after: number | null;
  change: number | null;
}

/** One target change on one pump, with the EEG response that followed. */
export interface TciStepResponse {
  tSeconds: number;
  model: string;
  drug: string;
  unit: string;
  fromCe: number | null;
  toCe: number;
  direction: "increase" | "decrease" | "start";
  beforeEpochs: number;
  afterEpochs: number;
  deltas: TciMetricDelta[];
  followedBy: { kind: string; severity: string; tSeconds: number; detail: string }[];
  summary: string;
}

/** Whole-case dose–response for one drug on one pump. */
export interface TciDoseResponse {
  model: string;
  drug: string;
  unit: string;
  minCe: number;
  maxCe: number;
  runningSeconds: number;
  /** Pearson r between the held Ce and each index across the infusion. */
  correlations: { metric: string; r: number | null; epochs: number }[];
  /** Mean indices at each distinct target held. */
  levels: {
    ce: number;
    seconds: number;
    meanSef95: number | null;
    meanDepth: number | null;
    meanSuppressionPct: number | null;
    meanSeizureScore: number | null;
  }[];
}

export interface TciResponseDigest {
  durationSeconds: number;
  pumps: {
    model: string;
    startedAt: number;
    stoppedAt: number | null;
    targets: Record<string, number>;
  }[];
  steps: TciStepResponse[];
  doseResponse: TciDoseResponse[];
  /** True when there is too little data for the AI to say anything useful. */
  sparse: boolean;
}

const METRICS = [
  { key: "depthIndex", label: "Depth index" },
  { key: "sef95Hz", label: "SEF95" },
  { key: "suppressionRatioPct", label: "Suppression ratio" },
  { key: "seizureScore", label: "Seizure score" },
  { key: "stateEntropy", label: "State entropy" },
  { key: "deltaAlphaRatio", label: "Delta/alpha ratio" },
  { key: "nociceptionIndex", label: "qNOX (nociception)" },
] as const;

function value(e: Epoch, key: string): number | null {
  switch (key) {
    case "depthIndex":
      return e.depth.index ?? null;
    case "sef95Hz":
      return e.sef95;
    case "suppressionRatioPct":
      return e.suppressionRatio;
    case "seizureScore":
      return e.seizureScore;
    case "stateEntropy":
      return e.entropy.state;
    case "deltaAlphaRatio":
      return e.ratios.deltaAlpha;
    case "nociceptionIndex":
      return e.composite.nIndex ?? null;
    default:
      return null;
  }
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(v: number | null, dp = 1): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

function describe(step: Omit<TciStepResponse, "summary">): string {
  const moved = step.deltas
    .filter((d) => d.change != null && Math.abs(d.change) > 0.5)
    .sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0))
    .slice(0, 2)
    .map((d) => `${d.metric} ${(d.change ?? 0) > 0 ? "+" : ""}${d.change}`);
  const verb =
    step.direction === "start" ? "started at" : step.direction === "increase" ? "up to" : "down to";
  const head = `${step.drug} ${verb} ${step.toCe} ${step.unit}`;
  if (!moved.length) return `${head} — no clear EEG change`;
  return `${head} — ${moved.join(", ")}`;
}

/**
 * Relates every recorded TCI target change to the EEG that followed, and the
 * held target to the indices across the infusion, so dosing impact can be read
 * against spectral, suppression and seizure-risk trends.
 */
export function buildTciResponseDigest(
  epochs: Epoch[],
  events: DetectedEvent[],
  infusions: TciInfusion[],
  elapsed: number,
): TciResponseDigest {
  const steps: TciStepResponse[] = [];
  const doseResponse: TciDoseResponse[] = [];

  for (const inf of infusions) {
    const model = tciModel(inf.modelKey);
    if (!model) continue;
    const stop = inf.stoppedAt ?? elapsed;

    for (const drug of model.drugs) {
      const points = ceHistory(inf, drug.key);

      points.forEach((p, idx) => {
        const before = epochs.filter((e) => e.t >= p.at - BEFORE_WINDOW && e.t < p.at);
        const after = epochs.filter((e) => e.t >= p.at && e.t <= p.at + AFTER_WINDOW);
        if (!after.length) return;
        const deltas: TciMetricDelta[] = METRICS.map((m) => {
          const b = mean(before.map((e) => value(e, m.key)).filter((v): v is number => v != null));
          const a = mean(after.map((e) => value(e, m.key)).filter((v): v is number => v != null));
          return {
            metric: m.label,
            before: round(b),
            after: round(a),
            change: b != null && a != null ? round(a - b) : null,
          };
        });
        const prev = idx > 0 ? points[idx - 1]!.value : null;
        const partial = {
          tSeconds: Math.round(p.at),
          model: model.short,
          drug: drug.label,
          unit: drug.unit,
          fromCe: prev,
          toCe: p.value,
          direction:
            idx === 0
              ? ("start" as const)
              : prev != null && p.value > prev
                ? ("increase" as const)
                : ("decrease" as const),
          beforeEpochs: before.length,
          afterEpochs: after.length,
          deltas,
          followedBy: events
            .filter((ev) => ev.t >= p.at && ev.t <= p.at + AFTER_WINDOW)
            .slice(0, 4)
            .map((ev) => ({
              kind: ev.kind,
              severity: String(ev.severity ?? ""),
              tSeconds: Math.round(ev.t),
              detail: ev.detail ?? "",
            })),
        };
        steps.push({ ...partial, summary: describe(partial) });
      });

      // Held target per epoch across this infusion, for a dose–response read.
      const within = epochs.filter((e) => e.t >= inf.startedAt && e.t <= stop);
      if (!within.length) continue;
      const ceAt = (t: number) => {
        let held = points[0]?.value ?? 0;
        for (const p of points) if (p.at <= t) held = p.value;
        return held;
      };
      const ces = within.map((e) => ceAt(e.t));
      const correlations = METRICS.map((m) => {
        const pairs = within
          .map((e, i) => ({ x: ces[i]!, y: value(e, m.key) }))
          .filter((p): p is { x: number; y: number } => p.y != null);
        return {
          metric: m.label,
          r:
            pairs.length >= 10
              ? round(
                  pearson(
                    pairs.map((p) => p.x),
                    pairs.map((p) => p.y),
                  ),
                  2,
                )
              : null,
          epochs: pairs.length,
        };
      });
      const byLevel = new Map<number, Epoch[]>();
      within.forEach((e, i) => {
        const ce = ces[i]!;
        const bucket = byLevel.get(ce) ?? [];
        bucket.push(e);
        byLevel.set(ce, bucket);
      });
      doseResponse.push({
        model: model.short,
        drug: drug.label,
        unit: drug.unit,
        minCe: Math.min(...ces),
        maxCe: Math.max(...ces),
        runningSeconds: Math.round(stop - inf.startedAt),
        correlations,
        levels: [...byLevel.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([ce, es]) => ({
            ce,
            seconds: es.length,
            meanSef95: round(mean(es.map((e) => e.sef95))),
            meanDepth: round(
              mean(es.map((e) => e.depth.index).filter((v): v is number => v != null)),
            ),
            meanSuppressionPct: round(mean(es.map((e) => e.suppressionRatio))),
            meanSeizureScore: round(mean(es.map((e) => e.seizureScore)), 2),
          })),
      });
    }
  }

  steps.sort((a, b) => a.tSeconds - b.tSeconds);
  return {
    durationSeconds: Math.round(elapsed),
    pumps: infusions.map((i) => ({
      model: tciModel(i.modelKey)?.label ?? i.modelKey,
      startedAt: Math.round(i.startedAt),
      stoppedAt: i.stoppedAt == null ? null : Math.round(i.stoppedAt),
      targets: i.targets,
    })),
    steps,
    doseResponse,
    sparse: steps.length === 0 && doseResponse.length === 0,
  };
}
