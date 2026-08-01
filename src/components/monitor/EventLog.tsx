import { AlertTriangle, Activity, MinusCircle, BookmarkCheck } from "lucide-react";

import type { DetectedEvent } from "@/lib/eeg/analysis";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

const meta = {
  seizure: { icon: AlertTriangle, label: "Possible seizure activity" },
  burst_suppression: { icon: Activity, label: "Burst suppression" },
  isoelectric: { icon: MinusCircle, label: "Isoelectric period" },
  annotation: { icon: BookmarkCheck, label: "Clinical marker" },
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
              <p className="text-sm font-medium">{isMarker ? event.detail : label}</p>
              {isMarker ? null : <p className="text-xs text-muted-foreground">{event.detail}</p>}
              <p className="metric-value mt-0.5 text-[11px] text-muted-foreground">
                {formatClock(event.t)}
                {isMarker ? " · marked by clinician" : ` · ${event.duration.toFixed(0)} s`}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}