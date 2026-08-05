import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";

import { DsaChart, marginsFor, type DsaTrace } from "@/components/monitor/DsaChart";
import { Button } from "@/components/ui/button";
import { HemiQualityBadge } from "@/components/monitor/HemiQualityBadge";
import { HemiEventOverlay } from "@/components/monitor/HemiEventOverlay";
import { TciTimeline } from "@/components/monitor/TciTimeline";
import type { TciInfusion } from "@/lib/eeg/tci";
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

/** Shortest inspectable slice; below this the heat map has no useful detail. */
const MIN_SPAN_SECONDS = 10;

interface DsaViewport {
  /** Seconds-ago at the left (older) edge. */
  from: number;
  /** Seconds-ago at the right (newer) edge. */
  to: number;
}

/**
 * Wheel/pinch zoom and drag pan over one lane, anchored on the cursor so the
 * epoch under the pointer stays put. Wheel must be a native non-passive
 * listener — React's onWheel is passive and cannot preventDefault.
 */
function LaneInteract({
  view,
  windowSeconds,
  onChange,
  children,
}: {
  view: DsaViewport;
  windowSeconds: number;
  onChange: (next: DsaViewport) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ view, windowSeconds, onChange });
  latest.current = { view, windowSeconds, onChange };
  const drag = useRef<{ x: number; from: number; to: number } | null>(null);

  /** Plot geometry in CSS px, matching the canvas margins. */
  const plotOf = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const m = marginsFor(rect.width, rect.height);
    return { left: rect.left + m.left, w: Math.max(1, rect.width - m.left - m.right) };
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view: v, windowSeconds: ws, onChange: cb } = latest.current;
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      const span = v.from - v.to;
      const next = Math.min(ws, Math.max(MIN_SPAN_SECONDS, span * Math.exp(dy * 0.0015)));
      const { left, w } = plotOf(el);
      const frac = Math.max(0, Math.min(1, (e.clientX - left) / w));
      // Keep the age under the cursor fixed while the span changes.
      const anchor = v.from - frac * span;
      let to = anchor - (1 - frac) * next;
      to = Math.max(0, Math.min(ws - next, to));
      cb({ from: to + next, to });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const span = view.from - view.to;
  const zoomed = span < windowSeconds - 0.5;

  return (
    <div
      ref={ref}
      className={cn("relative min-h-0 flex-1", zoomed && "cursor-grab active:cursor-grabbing")}
      style={zoomed ? { touchAction: "none" } : undefined}
      onPointerDown={(e) => {
        if (!zoomed) return;
        drag.current = { x: e.clientX, from: view.from, to: view.to };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const { w } = plotOf(e.currentTarget);
        const dAge = ((e.clientX - d.x) / w) * span;
        const to = Math.max(0, Math.min(windowSeconds - span, d.to + dAge));
        onChange({ from: to + span, to });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      {children}
    </div>
  );
}

interface Props {
  hemiSpectra: HemiSpectra[];
  hemiLatest: HemiLatest | null;
  hemiEvents: HemiEvent[];
  dsaView: DsaView;
  windowSeconds: number;
  elapsed: number;
  /** Tighter type scale and spacing for the bedside fullscreen monitor. */
  compact?: boolean;
  /** TCI pumps drawn as a dosing lane on the same time axis. */
  infusions?: TciInfusion[];
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
  infusions = [],
}: Props) {
  // One shared viewport across every lane so left/right stay time-aligned.
  const [view, setView] = useState<DsaViewport>({ from: windowSeconds, to: 0 });
  useEffect(() => {
    setView((v) => {
      const s = Math.min(windowSeconds, Math.max(MIN_SPAN_SECONDS, v.from - v.to));
      const to = Math.max(0, Math.min(windowSeconds - s, v.to));
      return { from: to + s, to };
    });
  }, [windowSeconds]);

  const span = view.from - view.to;
  const zoomed = span < windowSeconds - 0.5;
  const zoomBy = useCallback(
    (factor: number) => {
      setView((v) => {
        const cur = v.from - v.to;
        const next = Math.min(windowSeconds, Math.max(MIN_SPAN_SECONDS, cur * factor));
        const centre = (v.from + v.to) / 2;
        const to = Math.max(0, Math.min(windowSeconds - next, centre - next / 2));
        return { from: to + next, to };
      });
    },
    [windowSeconds],
  );

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
    <div className="flex h-full min-h-0 flex-col">
      {/* Zoom / pan toolbar — shared by every lane so context is never lost. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-0.5">
        <span className="metric-value text-xs text-muted-foreground">
          {zoomed
            ? `-${Math.round(view.from)}s → -${Math.round(view.to)}s`
            : `Last ${Math.round(windowSeconds)}s · live`}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Zoom out DSA"
            disabled={!zoomed}
            onClick={() => zoomBy(1.6)}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Zoom in DSA"
            disabled={span <= MIN_SPAN_SECONDS}
            onClick={() => zoomBy(1 / 1.6)}
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Reset DSA zoom to live view"
            disabled={!zoomed && view.to === 0}
            onClick={() => setView({ from: windowSeconds, to: 0 })}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className={cn("grid min-h-0 flex-1", dsaView === "bilateral" && "grid-rows-2")}>
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
          <LaneInteract view={view} windowSeconds={windowSeconds} onChange={setView}>
            <DsaChart
              frames={lane.frames}
              windowSeconds={windowSeconds}
              traces={lane.traces}
              view={view}
            />
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
            view={view}
          />
          </LaneInteract>
        </div>
      ))}
      </div>
      <TciTimeline
        infusions={infusions}
        elapsed={elapsed}
        windowSeconds={windowSeconds}
        view={view}
        compact={compact}
      />
    </div>
  );
}

export const HemiDsaPanel = memo(HemiDsaPanelInner);
