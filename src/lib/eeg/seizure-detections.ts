/**
 * Retrospective summary of the seizure detector's output for one saved case.
 *
 * Stored `eeg_events` are per-epoch alerts; clinicians reason in runs ("a
 * two-minute rhythmic run at 14:32"), so contiguous alerts are merged into
 * episodes before anything is shown or counted.
 */

export interface StoredSeizureEvent {
  kind: string;
  severity: string | null;
  t_offset_seconds: number | string;
  duration_seconds: number | string | null;
  detail: string | null;
}

export interface SeizureRun {
  /** Session-relative start of the run, seconds. */
  start: number;
  /** Session-relative end of the run, seconds. */
  end: number;
  seconds: number;
  /** Number of stored alert epochs merged into this run. */
  epochs: number;
  /** Worst severity seen inside the run. */
  severity: "critical" | "warning" | "info";
  /** First non-empty detail string, used as the run label. */
  detail: string | null;
}

export interface SeizureDetectionSummary {
  runs: SeizureRun[];
  /** Total alerting time, seconds. */
  totalSeconds: number;
  /** Longest single run, seconds. */
  longestSeconds: number;
  /** Alerting runs scaled to one hour of recording. */
  runsPerHour: number;
  /** Share of the recording spent in alert, 0–1. */
  burdenFraction: number;
  /** Highest severity across all runs, or null when nothing fired. */
  worstSeverity: SeizureRun["severity"] | null;
}

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

function severityOf(value: string | null | undefined): SeizureRun["severity"] {
  return value === "critical" ? "critical" : value === "warning" ? "warning" : "info";
}

function num(value: number | string | null | undefined, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? (n as number) : fallback;
}

/** True when an event row came from the seizure detector rather than a manual mark. */
export function isSeizureEvent(event: StoredSeizureEvent): boolean {
  return event.kind === "seizure";
}

/**
 * Merges stored seizure alerts into episodes. Alerts separated by no more than
 * `gapSeconds` of quiet are treated as one clinical episode, matching how the
 * bedside detector re-arms between epochs.
 */
export function summariseSeizureDetections(
  events: StoredSeizureEvent[],
  durationSeconds: number,
  gapSeconds = 30,
): SeizureDetectionSummary {
  const alerts = events
    .filter(isSeizureEvent)
    .map((e) => ({
      start: Math.max(0, num(e.t_offset_seconds)),
      length: Math.max(1, num(e.duration_seconds, 1)),
      severity: severityOf(e.severity),
      detail: e.detail?.trim() || null,
    }))
    .sort((a, b) => a.start - b.start);

  const runs: SeizureRun[] = [];
  for (const a of alerts) {
    const last = runs[runs.length - 1];
    if (last && a.start - last.end <= gapSeconds) {
      last.end = Math.max(last.end, a.start + a.length);
      last.seconds = last.end - last.start;
      last.epochs += 1;
      if (SEVERITY_RANK[a.severity]! > SEVERITY_RANK[last.severity]!) last.severity = a.severity;
      last.detail = last.detail ?? a.detail;
      continue;
    }
    runs.push({
      start: a.start,
      end: a.start + a.length,
      seconds: a.length,
      epochs: 1,
      severity: a.severity,
      detail: a.detail,
    });
  }

  const totalSeconds = runs.reduce((sum, r) => sum + r.seconds, 0);
  const hours = durationSeconds > 0 ? durationSeconds / 3600 : 0;
  return {
    runs,
    totalSeconds,
    longestSeconds: runs.reduce((max, r) => Math.max(max, r.seconds), 0),
    runsPerHour: hours > 0 ? runs.length / hours : 0,
    burdenFraction: durationSeconds > 0 ? Math.min(1, totalSeconds / durationSeconds) : 0,
    worstSeverity: runs.length
      ? runs.reduce<SeizureRun["severity"]>(
          (worst, r) => (SEVERITY_RANK[r.severity]! > SEVERITY_RANK[worst]! ? r.severity : worst),
          "info",
        )
      : null,
  };
}

/**
 * Expected false-alarm runs in a recording of this length, given the detector's
 * measured false-alarm rate on non-ictal validation material. Lets the timeline
 * say "3 runs, ~0.2 expected from noise alone" instead of a bare count.
 */
export function expectedFalseRuns(durationSeconds: number, falseAlarmsPerHour: number): number {
  if (!(durationSeconds > 0) || !(falseAlarmsPerHour > 0)) return 0;
  return (durationSeconds / 3600) * falseAlarmsPerHour;
}
