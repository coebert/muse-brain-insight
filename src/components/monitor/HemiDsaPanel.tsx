import { memo, useMemo } from "react";

import { DsaChart, type DsaTrace } from "@/components/monitor/DsaChart";
import { HemiQualityBadge } from "@/components/monitor/HemiQualityBadge";
import { HemiEventOverlay } from "@/components/monitor/HemiEventOverlay";
import {
  combineHemiSpectra,
  hemiSefTraces,
  worstHemi,
  type DsaView,
  type HemiEvent,
  type HemiLatest,
  type HemiMetrics,
  type HemiSpectra,
} from "@/hooks/useEegMonitor";
import { cn } from "@/lib/utils";

export const LEFT_TRACE_COLOR = "rgb(96,208,255)";
export const RIGHT_TRACE_COLOR = "rgb(255,176,64)";

interface Props {
  hemiSpectra: HemiSpectra[];
  hemiLatest: HemiLatest | null;
  hemiEvents: HemiEvent[];
  dsaView: DsaView;
  windowSeconds: number;
  elapsed: number;
  /** Tighter type scale and spacing for the bedside fullscreen monitor. */
  compact?: boolean;
}

interface Lane {
  key: string;
  side: string;
  montage: string;
  frames: number[][];
  metrics: HemiMetrics | null;
  overlaySide: "left" | "right" | "both";
  traces: DsaTrace[] | undefined;
}

/**
 * The bilateral / combined / overlay DSA lanes. Shared by the dashboard and the
 * fullscreen bedside monitor so the two views can never drift apart.
 */
function HemiDsaPanelInner({
  hemiSpectra,
  hemiLatest,
  hemiEvents,
  dsaView,
  windowSeconds,
  elapsed,
  compact = false,
}: Props) {
  const lanes = useMemo<Lane[]>(() => {
    if (dsaView === "bilateral") {
      return [
        {
          key: "left",
          side: compact ? "L" : "Left",
          montage: compact ? "TP9+AF7" : "TP9 + AF7",
          frames: hemiSpectra.map((h) => h.left),
          metrics: hemiLatest?.left ?? null,
          overlaySide: "left",
          traces: undefined,
        },
        {
          key: "right",
          side: compact ? "R" : "Right",
          montage: compact ? "AF8+TP10" : "AF8 + TP10",
          frames: hemiSpectra.map((h) => h.right),
          metrics: hemiLatest?.right ?? null,
          overlaySide: "right",
          traces: undefined,
        },
      ];
    }
    const overlay = dsaView === "overlay";
    let traces: DsaTrace[] | undefined;
    if (overlay) {
      const t = hemiSefTraces(hemiSpectra);
      traces = [
        { label: "Left SEF95", color: LEFT_TRACE_COLOR, values: t.left },
        { label: "Right SEF95", color: RIGHT_TRACE_COLOR, values: t.right },
      ];
    }
    return [
      {
        key: "combined",
        side: compact ? "L+R" : overlay ? "Overlay" : "Combined",
        montage: overlay
          ? compact
            ? "SEF95 overlay"
            : "L vs R SEF95"
          : compact
            ? "mean"
            : "L + R mean",
        frames: combineHemiSpectra(hemiSpectra),
        metrics: worstHemi(hemiLatest),
        overlaySide: "both",
        traces,
      },
    ];
  }, [hemiSpectra, hemiLatest, dsaView, compact]);

  return (
    <div className={cn("grid h-full", dsaView === "bilateral" && "grid-rows-2")}>
      {lanes.map((lane) => (
        <div
          key={lane.key}
          className="flex min-h-0 flex-col border-b border-border/60 last:border-b-0"
        >
          {/* Lane header sits above the plot so nothing overlaps the heat map. */}
          <div className="flex min-h-0 shrink-0 items-center gap-2 px-2 py-1">
            <span
              className={cn(
                "metric-value min-w-0 truncate text-xs text-foreground",
                !compact && "tracking-[0.12em] uppercase",
              )}
            >
              {lane.side} · {lane.montage}
            </span>
            <HemiQualityBadge metrics={lane.metrics} compact className="ml-auto shrink-0" />
          </div>
          <div className="relative min-h-0 flex-1">
            <DsaChart frames={lane.frames} windowSeconds={windowSeconds} traces={lane.traces} />
          {dsaView === "overlay" ? (
            <div
              className={cn(
                "metric-value absolute right-2 z-10 flex rounded bg-background/70 text-xs",
                compact ? "bottom-7 gap-2 px-1.5 py-0.5" : "bottom-8 gap-3 px-2 py-1",
              )}
            >
              <span className="flex items-center gap-1" style={{ color: LEFT_TRACE_COLOR }}>
                {compact ? null : (
                  <span className="h-0.5 w-4" style={{ backgroundColor: LEFT_TRACE_COLOR }} />
                )}
                {compact ? "— L SEF95" : "L SEF95"}
              </span>
              <span className="flex items-center gap-1" style={{ color: RIGHT_TRACE_COLOR }}>
                {compact ? null : (
                  <span className="h-0.5 w-4" style={{ backgroundColor: RIGHT_TRACE_COLOR }} />
                )}
                {compact ? "— R SEF95" : "R SEF95"}
              </span>
            </div>
          ) : null}
          <HemiEventOverlay
            events={hemiEvents}
            side={lane.overlaySide}
            elapsed={elapsed}
            windowSeconds={windowSeconds}
            compact={compact}
          />
          </div>
        </div>
      ))}
    </div>
  );
}

export const HemiDsaPanel = memo(HemiDsaPanelInner);
