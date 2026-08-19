import { AlertTriangle, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { SeizureValidationPanel } from "@/components/monitor/SeizureValidationPanel";
import { DEFAULT_SETTINGS } from "@/lib/eeg/analysis";
import { RECORDED_FALSE_ALARMS_PER_HOUR } from "@/lib/eeg/seizure-validation";
import {
  expectedFalseRuns,
  summariseSeizureDetections,
  type StoredSeizureEvent,
} from "@/lib/eeg/seizure-detections";
import { cn } from "@/lib/utils";

const SEVERITY_TONE: Record<string, string> = {
  critical: "border-critical/50 bg-critical/10 text-critical",
  warning: "border-caution/50 bg-caution/10 text-caution",
  info: "border-border bg-muted/40 text-muted-foreground",
};

const SEVERITY_FILL: Record<string, string> = {
  critical: "var(--critical)",
  warning: "var(--caution)",
  info: "var(--muted-foreground)",
};

/**
 * Where the seizure detector fired across a saved case, merged into episodes and
 * placed on the same time base as the DSA, with the detector's measured
 * performance available alongside so a run can be judged in context.
 */
export function SeizureDetectionTimeline({
  events,
  durationSeconds,
  onSeek,
  cursor = null,
  falseAlarmsPerHour = RECORDED_FALSE_ALARMS_PER_HOUR,
  className,
}: {
  events: StoredSeizureEvent[];
  durationSeconds: number;
  /** Moves the shared scrubber to a detection. */
  onSeek?: (seconds: number) => void;
  cursor?: number | null;
  /** Validated false-alarm rate used to contextualise the run count. */
  falseAlarmsPerHour?: number;
  className?: string;
}) {
  const summary = summariseSeizureDetections(events, durationSeconds);
  const span = Math.max(1, durationSeconds);
  const pos = (t: number) => `${Math.min(100, Math.max(0, (t / span) * 100))}%`;
  // Contextualises the count against the detector's validated false-alarm rate.
  const expectedFalse = expectedFalseRuns(durationSeconds, falseAlarmsPerHour);

  return (
    <section className={cn("panel px-3 py-3 sm:px-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Zap className="size-4 text-critical" />
            Seizure detections ({summary.runs.length})
          </h2>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {summary.runs.length
              ? `${formatDuration(Math.round(summary.totalSeconds))} in alert (${(summary.burdenFraction * 100).toFixed(1)} % of the case), longest run ${formatDuration(Math.round(summary.longestSeconds))}, ${summary.runsPerHour.toFixed(1)} runs/h.`
              : "The detector did not raise a seizure alert in this recording."}
            {summary.runs.length && expectedFalse > 0
              ? ` Validation predicts about ${expectedFalse.toFixed(1)} false run${expectedFalse >= 1.95 ? "s" : ""} over a case this long.`
              : ""}
          </p>
        </div>
        {summary.worstSeverity === "critical" ? (
          <span className="flex shrink-0 items-center gap-1 rounded-md border border-critical/50 bg-critical/10 px-2 py-1 text-[11px] text-critical">
            <AlertTriangle className="size-3.5" />
            Critical run recorded
          </span>
        ) : null}
      </div>

      <div className="relative mt-3 h-7 overflow-hidden rounded-md border border-border bg-muted/30">
        {summary.runs.map((r) => (
          <button
            key={`${r.start}-${r.end}`}
            type="button"
            aria-label={`Seizure detection at ${formatClock(r.start)}, ${formatDuration(Math.round(r.seconds))}`}
            className="absolute inset-y-0 min-w-[3px] opacity-80 transition-opacity hover:opacity-100"
            style={{
              left: pos(r.start),
              width: `max(3px, ${((r.end - r.start) / span) * 100}%)`,
              background: SEVERITY_FILL[r.severity],
            }}
            onClick={() => onSeek?.(r.start)}
          />
        ))}
        {cursor != null ? (
          <span
            aria-hidden
            className="absolute inset-y-0 w-px bg-foreground/70"
            style={{ left: pos(cursor) }}
          />
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{formatClock(0)}</span>
        <span>{formatClock(durationSeconds)}</span>
      </div>

      {summary.runs.length ? (
        <ul className="mt-2 space-y-1">
          {summary.runs.map((r) => (
            <li
              key={`row-${r.start}`}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-2 text-xs",
                SEVERITY_TONE[r.severity],
              )}
            >
              <span className="metric-value">{formatClock(r.start)}</span>
              <span className="text-foreground">{formatDuration(Math.round(r.seconds))}</span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {r.detail ?? `${r.epochs} alerting epoch${r.epochs === 1 ? "" : "s"}`}
              </span>
              {onSeek ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11 shrink-0 px-2 text-xs sm:min-h-9"
                  onClick={() => onSeek(r.start)}
                >
                  Review
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <SeizureValidationPanel settings={DEFAULT_SETTINGS} className="mt-3 border-dashed" />
    </section>
  );
}
