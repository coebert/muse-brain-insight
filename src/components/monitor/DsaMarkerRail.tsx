import { memo } from "react";

import { cn } from "@/lib/utils";

export interface DsaMarker {
  /** Seconds since session start. */
  t: number;
  label: string;
  tone: "marker" | "caution" | "critical";
  /** Label at the top of the lane rather than the bottom. */
  top?: boolean;
}

const line: Record<DsaMarker["tone"], string> = {
  marker: "bg-marker/80",
  caution: "bg-caution/80",
  critical: "bg-critical/80",
};

const chip: Record<DsaMarker["tone"], string> = {
  marker: "bg-marker/20 text-marker",
  caution: "bg-caution/20 text-caution",
  critical: "bg-critical/20 text-critical",
};

/**
 * Vertical time markers drawn over a DSA lane. Shared by the dashboard and the
 * fullscreen monitor so marker placement maths lives in one place.
 */
function DsaMarkerRailInner({
  markers,
  elapsed,
  windowSeconds,
}: {
  markers: DsaMarker[];
  elapsed: number;
  windowSeconds: number;
}) {
  return (
    <>
      {markers.map((m, i) => {
        const age = elapsed - m.t;
        if (age > windowSeconds || age < 0) return null;
        const left = (1 - age / windowSeconds) * 100;
        return (
          <div
            key={`${m.tone}-${m.t}-${i}`}
            className="pointer-events-none absolute top-0 bottom-0 z-10"
            style={{ left: `${left}%` }}
          >
            <div className={cn("h-full w-px", line[m.tone])} />
            <span
              className={cn(
                "metric-value absolute max-w-[150px] truncate rounded px-1 py-0.5 text-xs whitespace-nowrap",
                chip[m.tone],
                m.top ? "top-1" : "bottom-1",
                left > 65 ? "right-1" : "left-1",
              )}
            >
              {m.label}
            </span>
          </div>
        );
      })}
    </>
  );
}

export const DsaMarkerRail = memo(DsaMarkerRailInner);