import { memo } from "react";
import type { HemiEvent, HemiSide } from "@/hooks/useEegMonitor";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

interface Props {
  events: HemiEvent[];
  /** Which hemisphere lane this overlay sits on; "both" for the combined lane. */
  side: HemiSide | "both";
  /** Session elapsed time in seconds (right edge of the DSA). */
  elapsed: number;
  windowSeconds: number;
  compact?: boolean;
}

const SIDE_LABEL: Record<HemiSide, string> = { left: "L", right: "R" };

/** Markers detected on weak signal deserve a visual caveat. */
const LOW_SQI = 40;
const HIGH_EMG = 50;

/**
 * Burst-suppression and seizure episodes drawn over one hemisphere's DSA lane,
 * time-aligned with the heat map and hoverable for detail.
 */
function HemiEventOverlayInner({ events, side, elapsed, windowSeconds, compact }: Props) {
  const visible = events.filter((e) => {
    if (side !== "both" && e.side !== side) return false;
    return elapsed - (e.t + e.duration) < windowSeconds;
  });
  if (!visible.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {visible.map((e, i) => {
        const startAge = elapsed - e.t;
        const endAge = Math.max(elapsed - (e.t + e.duration), 0);
        const left = Math.max((1 - startAge / windowSeconds) * 100, 0);
        const right = (1 - endAge / windowSeconds) * 100;
        const width = Math.max(right - left, 0.6);
        const seizure = e.kind === "seizure";
        const label = seizure ? "Seizure" : "Burst supp.";
        const suspect = e.minSqi < LOW_SQI || e.peakEmg > HIGH_EMG;
        return (
          <div
            key={`${e.side}-${e.kind}-${e.t}-${i}`}
            className="group pointer-events-auto absolute top-0 bottom-0"
            style={{ left: `${left}%`, width: `${width}%` }}
          >
            <div
              className={cn(
                "h-full border-x",
                seizure
                  ? "border-critical/80 bg-critical/20"
                  : "border-caution/80 bg-caution/15",
                suspect && "border-dashed opacity-70",
                e.ongoing && "animate-pulse",
              )}
            />
            <span
              className={cn(
                "metric-value absolute top-1 left-0 max-w-[130px] truncate rounded px-1 py-px text-xs whitespace-nowrap",
                seizure ? "bg-critical/25 text-critical" : "bg-caution/25 text-caution",
                compact && "text-[11px]",
              )}
            >
              {side === "both" ? `${SIDE_LABEL[e.side]} · ` : ""}
              {compact ? (seizure ? "SZ" : "BS") : label}
              {` · SQI ${Math.round(e.sqiAtOnset)}%`}
              {suspect ? " ⚠" : ""}
            </span>
            <div
              className={cn(
                "pointer-events-none absolute top-7 z-20 hidden w-52 rounded-md border border-border bg-popover/95 p-2 text-xs text-popover-foreground shadow-lg group-hover:block",
                left > 60 ? "right-0" : "left-0",
              )}
            >
              <p className="metric-value mb-1 text-xs tracking-[0.1em] uppercase">
                {label} · {e.side === "left" ? "Left (TP9+AF7)" : "Right (AF8+TP10)"}
              </p>
              <p>Onset {formatClock(e.t)}</p>
              <p>
                Duration {formatDuration(e.duration)}
                {e.ongoing ? " (ongoing)" : ""}
              </p>
              <p>
                {seizure
                  ? `Peak seizure score ${(e.peakScore * 100).toFixed(0)}%`
                  : `Peak SR ${e.peakSr.toFixed(0)}%`}
              </p>
              <p className="text-muted-foreground">Signal quality at onset: {e.quality}</p>
              <p className="text-muted-foreground">
                SQI {Math.round(e.sqiAtOnset)}% at onset · min {Math.round(e.minSqi)}%
              </p>
              <p className="text-muted-foreground">
                EMG {Math.round(e.emgAtOnset)}% at onset · peak {Math.round(e.peakEmg)}%
              </p>
              {suspect && (
                <p className="mt-1 text-caution">
                  ⚠ Detected during poor signal — interpret with caution.
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const HemiEventOverlay = memo(HemiEventOverlayInner);
