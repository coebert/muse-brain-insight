import { Bell, BellOff, Check, TriangleAlert, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ActiveAlarm } from "@/hooks/useAlarms";
import { PRIORITY_LABEL } from "@/lib/eeg/alarms";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

const TONE = {
  high: "border-critical bg-critical/10 text-critical",
  medium: "border-caution bg-caution/10 text-caution",
  low: "border-border bg-muted/40 text-muted-foreground",
} as const;

/**
 * Persistent alarm strip. Alarms latch until acknowledged, so nothing that
 * fired while the clinician was looking away disappears silently.
 */
export function AlarmBanner({
  alarms,
  audioEnabled,
  muted,
  muteRemaining,
  onAcknowledge,
  onAcknowledgeAll,
  onPauseAudio,
  onResumeAudio,
  onToggleAudio,
}: {
  alarms: ActiveAlarm[];
  audioEnabled: boolean;
  muted: boolean;
  muteRemaining: number;
  onAcknowledge: (id: string) => void;
  onAcknowledgeAll: () => void;
  onPauseAudio: () => void;
  onResumeAudio: () => void;
  onToggleAudio: () => void;
}) {
  const unacked = alarms.filter((a) => a.acknowledgedAt == null);

  return (
    <section
      aria-label="Alarms"
      className={cn(
        "panel overflow-hidden",
        unacked.some((a) => a.priority === "high") && "alert-pulse border-critical",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2 sm:px-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {unacked.length ? (
            <TriangleAlert className="size-4 text-critical" />
          ) : (
            <Bell className="size-4 text-muted-foreground" />
          )}
          Alarms
        </h2>
        <span className="metric-value text-[11px] text-muted-foreground">
          {unacked.length
            ? `${unacked.length} unacknowledged`
            : alarms.length
              ? "all acknowledged"
              : "no active alarms"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {muted ? (
            <Button size="sm" variant="outline" onClick={onResumeAudio}>
              <VolumeX className="size-4" /> Muted {muteRemaining}s
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onPauseAudio} disabled={!audioEnabled}>
              <Volume2 className="size-4" /> Pause 2 min
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onToggleAudio}
            title={audioEnabled ? "Turn alarm sound off" : "Turn alarm sound on"}
          >
            {audioEnabled ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          </Button>
          {unacked.length > 1 ? (
            <Button size="sm" onClick={onAcknowledgeAll}>
              <Check className="size-4" /> Acknowledge all
            </Button>
          ) : null}
        </div>
      </div>

      {alarms.length ? (
        <ul className="divide-y divide-border">
          {alarms.map((a) => (
            <li
              key={a.id}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-4 px-3 py-2 sm:px-4",
                TONE[a.priority],
                a.acknowledgedAt != null && "opacity-60",
              )}
            >
              <span className="metric-value text-[11px] uppercase">
                {PRIORITY_LABEL[a.priority]}
              </span>
              <span className="text-sm font-semibold text-foreground">{a.title}</span>
              <span className="text-xs text-muted-foreground">{a.detail}</span>
              <span className="metric-value text-[11px] text-muted-foreground">
                {formatClock(a.t)}
                {a.resolved ? " · resolved" : ""}
              </span>
              {a.acknowledgedAt == null ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  onClick={() => onAcknowledge(a.id)}
                >
                  <Check className="size-4" /> Acknowledge
                </Button>
              ) : (
                <span className="metric-value ml-auto text-[11px] text-muted-foreground">
                  acknowledged
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          Seizure activity, deep suppression, signal loss and depth swings raise an audible,
          latching alarm here.
        </p>
      )}
    </section>
  );
}