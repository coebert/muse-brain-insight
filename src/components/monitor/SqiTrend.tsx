import { useMemo } from "react";
import { Activity } from "lucide-react";

import type { SqiPoint } from "@/hooks/useEegMonitor";
import { cn } from "@/lib/utils";

interface Props {
  history: SqiPoint[];
  /** Show the per-hemisphere traces as well as the combined SQI. */
  bilateral?: boolean;
  /** Alert threshold, 0–100 %, drawn as a dashed reference line. */
  threshold?: number;
  className?: string;
}

const W = 600;
const H = 90;

function path(points: SqiPoint[], pick: (p: SqiPoint) => number): string {
  if (points.length < 2) return "";
  const t0 = points[0]!.t;
  const span = Math.max(1, points[points.length - 1]!.t - t0);
  return points
    .map((p, i) => {
      const x = ((p.t - t0) / span) * W;
      const y = H - (Math.max(0, Math.min(100, pick(p))) / 100) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function tone(v: number): string {
  return v >= 70 ? "text-normal" : v >= 40 ? "text-caution" : "text-critical";
}

/**
 * BIS-style Signal Quality Index trend — how trustworthy the EEG has been
 * across the whole case, not just right now.
 */
export function SqiTrend({ history, bilateral = true, threshold, className }: Props) {
  const stats = useMemo(() => {
    if (!history.length) return null;
    const mean = history.reduce((a, p) => a + p.sqi, 0) / history.length;
    const poor = history.filter((p) => p.sqi < 40).length / history.length;
    const spanMinutes = (history[history.length - 1]!.t - history[0]!.t) / 60;
    return { mean, poor, spanMinutes, current: history[history.length - 1]!.sqi };
  }, [history]);

  return (
    <div className={cn("panel px-4 py-4", className)}>
      <div className="flex items-center gap-2">
        <Activity className={cn("size-4", stats ? tone(stats.current) : "text-muted-foreground")} />
        <h2 className="text-sm font-semibold">Signal quality index — trend</h2>
        <span
          className={cn(
            "metric-value ml-auto text-xs uppercase",
            stats ? tone(stats.current) : "text-muted-foreground",
          )}
        >
          {stats ? `SQI ${stats.current.toFixed(0)} %` : "—"}
        </span>
      </div>

      {stats ? (
        <>
          <div className="relative mt-3">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="h-24 w-full"
              role="img"
              aria-label="Signal quality index over time"
            >
              {/* Usability bands: below 40 % metrics are unreliable. */}
              <rect x="0" y={H * 0.6} width={W} height={H * 0.4} className="fill-critical/10" />
              <rect x="0" y={H * 0.3} width={W} height={H * 0.3} className="fill-caution/10" />
              {[0, 40, 70, 100].map((v) => (
                <line
                  key={v}
                  x1="0"
                  x2={W}
                  y1={H - (v / 100) * H}
                  y2={H - (v / 100) * H}
                  className="stroke-border"
                  strokeWidth="0.5"
                />
              ))}
              <path
                d={path(history, (p) => p.emg)}
                fill="none"
                className="stroke-muted-foreground/50"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              {bilateral ? (
                <>
                  <path
                    d={path(history, (p) => p.left)}
                    fill="none"
                    stroke="hsl(var(--chart-left, 190 90% 55%))"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                    opacity="0.7"
                  />
                  <path
                    d={path(history, (p) => p.right)}
                    fill="none"
                    stroke="hsl(var(--chart-right, 38 95% 58%))"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                    opacity="0.7"
                  />
                </>
              ) : null}
              <path
                d={path(history, (p) => p.sqi)}
                fill="none"
                className="stroke-signal"
                strokeWidth="1.75"
                vectorEffect="non-scaling-stroke"
              />
              {threshold != null ? (
                <line
                  x1="0"
                  x2={W}
                  y1={H - (threshold / 100) * H}
                  y2={H - (threshold / 100) * H}
                  className="stroke-critical"
                  strokeWidth="1"
                  strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </svg>
            <span className="pointer-events-none absolute top-0 left-1 text-[10px] text-muted-foreground">
              100 %
            </span>
            <span className="pointer-events-none absolute bottom-0 left-1 text-[10px] text-muted-foreground">
              0 %
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-signal" /> Combined SQI
            </span>
            {bilateral ? (
              <>
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-0.5 w-4"
                    style={{ background: "hsl(var(--chart-left, 190 90% 55%))" }}
                  />{" "}
                  Left
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-0.5 w-4"
                    style={{ background: "hsl(var(--chart-right, 38 95% 58%))" }}
                  />{" "}
                  Right
                </span>
              </>
            ) : null}
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 border-t border-dashed border-muted-foreground" /> EMG
            </span>
            {threshold != null ? (
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 border-t border-dashed border-critical" /> Alert{" "}
                {threshold} %
              </span>
            ) : null}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            Mean SQI {stats.mean.toFixed(0)} % over {stats.spanMinutes.toFixed(0)} min ·{" "}
            {(stats.poor * 100).toFixed(0)} % of the case below 40 % (metrics unreliable).
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          The SQI trend builds once streaming starts.
        </p>
      )}
    </div>
  );
}