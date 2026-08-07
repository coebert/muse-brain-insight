import { useMemo, useState } from "react";
import { AlertTriangle, BellOff, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SeizureEvidenceCard } from "@/components/monitor/SeizureEvidenceCard";
import type { DetectedEvent } from "@/lib/eeg/analysis";
import type { HemiEvent } from "@/hooks/useEegMonitor";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

export interface SeizureAlertCardsProps {
  /** Merged session event log (detector events + clinician markers). */
  events: DetectedEvent[];
  /** Hemisphere-attributed episodes, used to label which side fired. */
  hemiEvents: HemiEvent[];
  /** Session elapsed time in seconds. */
  elapsed: number;
  /** Wall-clock ms at t = 0, so cards can show real time of day. */
  startedAtMs: number;
  /** Only show alerts from the trailing window (seconds). */
  windowSeconds?: number;
}

/** Onsets within this many seconds are treated as the same episode. */
const SIDE_MATCH_S = 20;

function wallClock(startedAtMs: number, t: number): string {
  const d = new Date(startedAtMs + t * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function sideLabel(sides: Set<string>): string {
  if (sides.has("left") && sides.has("right")) return "Bilateral";
  if (sides.has("left")) return "Left";
  if (sides.has("right")) return "Right";
  return "Unlateralised";
}

/**
 * Real-time seizure-suspicion alert cards for the bedside dashboard.
 *
 * Each detected ictal run appears as its own card with onset timestamp (both
 * session clock and time of day), duration, hemisphere, AI confidence and the
 * expandable "why this fired" evidence, and can be acknowledged individually.
 */
export function SeizureAlertCards({
  events,
  hemiEvents,
  elapsed,
  startedAtMs,
  windowSeconds = 15 * 60,
}: SeizureAlertCardsProps) {
  const [acknowledged, setAcknowledged] = useState<Record<string, true>>({});

  const alerts = useMemo(() => {
    return events
      .filter((e) => e.kind === "seizure" && elapsed - e.t <= windowSeconds)
      .map((e) => {
        const sides = new Set(
          hemiEvents
            .filter((h) => h.kind === "seizure" && Math.abs(h.t - e.t) <= SIDE_MATCH_S)
            .map((h) => h.side as string),
        );
        const ongoing = hemiEvents.some(
          (h) => h.kind === "seizure" && h.ongoing && Math.abs(h.t - e.t) <= SIDE_MATCH_S,
        );
        return { event: e, id: `seizure-${e.t.toFixed(1)}`, side: sideLabel(sides), ongoing };
      })
      .sort((a, b) => b.event.t - a.event.t);
  }, [events, hemiEvents, elapsed, windowSeconds]);

  const live = alerts.filter((a) => !acknowledged[a.id]);
  if (!live.length) return null;

  return (
    <section aria-label="Seizure alerts" className="space-y-2">
      {live.map(({ event, id, side, ongoing }) => (
        <article
          key={id}
          role="alert"
          className={cn(
            "panel border-critical/60 bg-critical/10 px-3 py-2.5 sm:px-4",
            ongoing && "animate-pulse",
          )}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AlertTriangle className="size-4 shrink-0 text-critical" aria-hidden />
            <h3 className="text-sm font-semibold text-critical">
              Seizure suspicion — {side.toLowerCase()}
            </h3>
            <span
              className={cn(
                "metric-value rounded border px-1.5 py-px text-[11px] tracking-[0.08em] uppercase",
                ongoing
                  ? "border-critical/50 bg-critical/15 text-critical"
                  : "border-border bg-muted/30 text-muted-foreground",
              )}
            >
              {ongoing ? "Ongoing" : "Resolved"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto min-h-11 gap-1.5 text-xs"
              onClick={() => setAcknowledged((prev) => ({ ...prev, [id]: true }))}
            >
              {ongoing ? <BellOff className="size-3.5" /> : <Check className="size-3.5" />}
              Acknowledge
            </Button>
          </div>

          <dl className="metric-value mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <div className="flex gap-1.5">
              <dt>Onset</dt>
              <dd className="text-foreground">
                {formatClock(event.t)} · {wallClock(startedAtMs, event.t)}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Duration</dt>
              <dd className="text-foreground">
                {formatDuration(ongoing ? Math.max(event.duration, elapsed - event.t) : event.duration)}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Hemisphere</dt>
              <dd className="text-foreground">{side}</dd>
            </div>
          </dl>

          <p className="mt-1 text-xs text-foreground/90">{event.detail}</p>

          {event.evidence ? <SeizureEvidenceCard evidence={event.evidence} /> : null}
        </article>
      ))}
    </section>
  );
}