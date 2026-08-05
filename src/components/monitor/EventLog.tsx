import {
  AlertTriangle,
  Activity,
  MinusCircle,
  BookmarkCheck,
  WifiOff,
  TrendingDown,
  TrendingUp,
  Waves,
  LogOut,
  LogIn,
} from "lucide-react";

import type { DetectedEvent } from "@/lib/eeg/analysis";
import { formatClock } from "@/lib/eeg/format";
import {
  SeizureConfidenceChip,
  SeizureEvidenceCard,
} from "@/components/monitor/SeizureEvidenceCard";
import { cn } from "@/lib/utils";

const meta = {
  seizure: { icon: AlertTriangle, label: "Possible seizure activity" },
  burst_suppression: { icon: Activity, label: "Burst suppression" },
  isoelectric: { icon: MinusCircle, label: "Isoelectric period" },
  annotation: { icon: BookmarkCheck, label: "Clinical marker" },
  signal_quality: { icon: WifiOff, label: "Signal quality degraded" },
  depth_drop: { icon: TrendingDown, label: "Depth index drop" },
  depth_rise: { icon: TrendingUp, label: "Depth index rise" },
  depth_window_exit: { icon: LogOut, label: "Left optimal depth window" },
  depth_window_return: { icon: LogIn, label: "Back in optimal depth window" },
  suppression_burden: { icon: Waves, label: "Burst-suppression burden" },
} as const;

export function EventLog({ events }: { events: DetectedEvent[] }) {
  if (!events.length) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No burst-suppression or ictal-appearing events detected yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {[...events].reverse().map((event, i) => {
        const { icon: Icon, label } = meta[event.kind];
        const isMarker = event.kind === "annotation";
        return (
          <li key={`${event.kind}-${event.t}-${i}`} className="flex gap-3 px-4 py-3">
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                isMarker
                  ? "text-marker"
                  : event.severity === "critical"
                    ? "text-critical"
                    : event.severity === "warning"
                      ? "text-caution"
                      : "text-muted-foreground",
              )}
            />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                {isMarker ? event.detail : label}
                {event.evidence ? <SeizureConfidenceChip evidence={event.evidence} /> : null}
              </p>
              {isMarker ? null : <p className="text-xs text-muted-foreground">{event.detail}</p>}
              <p className="metric-value mt-0.5 text-xs text-muted-foreground">
                {formatClock(event.t)}
                {isMarker ? " · marked by clinician" : ` · ${event.duration.toFixed(0)} s`}
              </p>
              {event.evidence ? <SeizureEvidenceCard evidence={event.evidence} /> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
