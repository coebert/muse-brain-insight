/**
 * The COEBIS history of one case, read as an anaesthesia arc.
 *
 * A single mean depth number hides the shape of a case: how quickly the
 * patient went down, how steady the maintenance was, and how the index
 * came back up at the end. This splits a filed recording's index trace
 * into induction, maintenance and emergence and grades each stretch on
 * its own. Boundaries come from the clinician's own state markers when
 * they exist, and only fall back to the index crossing the unconscious
 * band when they do not.
 */
import type { CaseObservation, StateLabel } from "./case-observations";
import { EVENT_LABEL, STATE_LABEL_TEXT, moaasLabel } from "./case-observations";

/** Above this the index is read as awake or close to it. */
export const AWAKE_INDEX = 60;
/** Below this the index is read as deeper than the usual surgical band. */
export const DEEP_INDEX = 40;
/** A crossing has to hold this long before it counts as a phase change. */
export const HOLD_SECONDS = 60;

export interface ArcSample {
  /** Seconds from the start of the recording. */
  t: number;
  index: number | null;
  suppression: number | null;
  sef: number | null;
}

export type PhaseName = "induction" | "maintenance" | "emergence";

export const PHASE_TEXT: Record<PhaseName, string> = {
  induction: "Induction",
  maintenance: "Maintenance",
  emergence: "Emergence",
};

export interface ArcPhase {
  name: PhaseName;
  start: number;
  end: number;
  seconds: number;
  /** Whether the boundary came from a tagged state or from the index itself. */
  source: "marker" | "index";
  readings: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Seconds spent under the deep line and over the awake line. */
  secondsDeep: number;
  secondsLight: number;
  secondsSuppressed: number;
  /** Share of the stretch inside the usual 40–60 surgical band. */
  inBand: number | null;
}

export interface ArcMarker {
  t: number;
  kind: CaseObservation["kind"];
  text: string;
}

export interface CaseArc {
  samples: ArcSample[];
  phases: ArcPhase[];
  markers: ArcMarker[];
  /** The whole case graded the same way, for comparison with each phase. */
  overall: ArcPhase | null;
  hasIndex: boolean;
  /** Seconds from the start to the index first settling below the awake line. */
  timeToUnconscious: number | null;
  /** Seconds from the index leaving the unconscious band to the end. */
  emergenceSeconds: number | null;
}

const clean = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(Number(v)) ? null : Number(v);

/** How long each reading stands for, so short and long cases grade alike. */
function widths(samples: ArcSample[]): number[] {
  if (samples.length < 2) return samples.map(() => 0);
  const gaps: number[] = [];
  for (let i = 1; i < samples.length; i++) gaps.push(samples[i]!.t - samples[i - 1]!.t);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return samples.map((_, i) => {
    const gap = i === 0 ? median : samples[i]!.t - samples[i - 1]!.t;
    return gap > 0 && gap < median * 10 ? gap : median;
  });
}

function grade(
  name: PhaseName,
  samples: ArcSample[],
  w: number[],
  start: number,
  end: number,
  source: ArcPhase["source"],
): ArcPhase {
  let readings = 0;
  let sum = 0;
  let min: number | null = null;
  let max: number | null = null;
  let deep = 0;
  let light = 0;
  let suppressed = 0;
  let inBand = 0;
  let held = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.t < start || s.t >= end) continue;
    const width = w[i] ?? 0;
    if (s.index == null) continue;
    readings++;
    sum += s.index;
    min = min == null ? s.index : Math.min(min, s.index);
    max = max == null ? s.index : Math.max(max, s.index);
    held += width;
    if (s.index < DEEP_INDEX) deep += width;
    else if (s.index > AWAKE_INDEX) light += width;
    else inBand += width;
    if ((s.suppression ?? 0) > 0) suppressed += width;
  }

  return {
    name,
    start,
    end,
    seconds: Math.max(0, end - start),
    source,
    readings,
    mean: readings ? sum / readings : null,
    min,
    max,
    secondsDeep: deep,
    secondsLight: light,
    secondsSuppressed: suppressed,
    inBand: held > 0 ? inBand / held : null,
  };
}

/** First moment the index settles below the awake line and stays there. */
function settledBelow(samples: ArcSample[]): number | null {
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.index == null || s.index >= AWAKE_INDEX) continue;
    let ok = true;
    for (let j = i + 1; j < samples.length; j++) {
      if (samples[j]!.t - s.t > HOLD_SECONDS) break;
      const v = samples[j]!.index;
      if (v != null && v >= AWAKE_INDEX) {
        ok = false;
        break;
      }
    }
    if (ok) return s.t;
  }
  return null;
}

/** Last moment the index rises back over the awake line and stays up. */
function roseAbove(samples: ArcSample[], after: number): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (s.t <= after) break;
    if (s.index == null || s.index <= AWAKE_INDEX) continue;
    let start = s.t;
    for (let j = i - 1; j >= 0; j--) {
      const v = samples[j]!.index;
      if (samples[j]!.t <= after) break;
      if (v == null) continue;
      if (v <= AWAKE_INDEX) break;
      start = samples[j]!.t;
    }
    return start;
  }
  return null;
}

const DEEP_STATES: StateLabel[] = ["anaesthetised", "sedated_unresponsive", "burst_suppression"];

function markerText(o: CaseObservation): string {
  if (o.kind === "state" && o.stateLabel) return STATE_LABEL_TEXT[o.stateLabel];
  if (o.kind === "event" && o.eventType) return EVENT_LABEL[o.eventType];
  if (o.kind === "drug")
    return [o.drugName, o.dose == null ? null : `${o.dose}${o.doseUnit ?? ""}`]
      .filter(Boolean)
      .join(" ");
  if (o.kind === "responsiveness" && o.moaas != null) return `MOAA/S ${o.moaas} — ${moaasLabel(o.moaas)}`;
  return o.note ?? "Note";
}

/** Build the per-case COEBIS history: trace, phases and the marks on it. */
export function buildCaseArc(
  input: ArcSample[],
  observations: CaseObservation[] = [],
): CaseArc {
  const samples = input
    .map((s) => ({
      t: Number(s.t) || 0,
      index: clean(s.index),
      suppression: clean(s.suppression),
      sef: clean(s.sef),
    }))
    .sort((a, b) => a.t - b.t);

  const hasIndex = samples.some((s) => s.index != null);
  const markers: ArcMarker[] = observations
    .filter((o) => Number.isFinite(o.atSeconds))
    .map((o) => ({ t: o.atSeconds, kind: o.kind, text: markerText(o) }))
    .sort((a, b) => a.t - b.t);

  if (!samples.length || !hasIndex) {
    return {
      samples,
      phases: [],
      markers,
      overall: null,
      hasIndex,
      timeToUnconscious: null,
      emergenceSeconds: null,
    };
  }

  const w = widths(samples);
  const first = samples[0]!.t;
  const last = samples[samples.length - 1]!.t;

  const deepMark = observations.find(
    (o) => o.kind === "state" && o.stateLabel && DEEP_STATES.includes(o.stateLabel),
  );
  const emergeMark = [...observations]
    .reverse()
    .find((o) => o.kind === "state" && o.stateLabel === "emergence");

  const downBy = settledBelow(samples);
  const inductionEnd = deepMark ? deepMark.atSeconds : downBy;
  const emergenceStart = emergeMark
    ? emergeMark.atSeconds
    : roseAbove(samples, inductionEnd ?? first);

  const phases: ArcPhase[] = [];
  const boundedEnd =
    inductionEnd != null ? Math.min(Math.max(inductionEnd, first), last) : null;
  const boundedEmerge =
    emergenceStart != null
      ? Math.min(Math.max(emergenceStart, boundedEnd ?? first), last)
      : null;

  if (boundedEnd != null && boundedEnd > first) {
    phases.push(grade("induction", samples, w, first, boundedEnd, deepMark ? "marker" : "index"));
  }
  const midStart = boundedEnd ?? first;
  const midEnd = boundedEmerge ?? last;
  if (midEnd > midStart) {
    phases.push(
      grade("maintenance", samples, w, midStart, midEnd, deepMark || emergeMark ? "marker" : "index"),
    );
  }
  if (boundedEmerge != null && last > boundedEmerge) {
    phases.push(
      grade("emergence", samples, w, boundedEmerge, last + 1, emergeMark ? "marker" : "index"),
    );
  }

  return {
    samples,
    phases,
    markers,
    overall: grade("maintenance", samples, w, first, last + 1, "index"),
    hasIndex,
    timeToUnconscious: boundedEnd == null ? null : boundedEnd - first,
    emergenceSeconds: boundedEmerge == null ? null : last - boundedEmerge,
  };
}
