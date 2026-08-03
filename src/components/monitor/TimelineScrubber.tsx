import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatClock } from "@/lib/eeg/format";

export interface ScrubWindow {
  alertId: string;
  title: string;
  severity: string;
  start: number;
  end: number;
  /** EEG/evidence completeness for this window. */
  dataLevel?: "ok" | "partial" | "insufficient";
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-critical",
  warning: "bg-caution",
  advisory: "bg-muted-foreground",
};

interface Props {
  durationSeconds: number;
  cursor: number;
  onCursorChange: (t: number) => void;
  windows: ScrubWindow[];
  selectedAlertId: string | null;
  onSelectWindow: (alertId: string | null) => void;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  /** Metric readout at the cursor epoch. */
  readout: { label: string; value: string }[];
}

/**
 * Scrubber that drives the shared review cursor across the session DSA and the
 * metric trends, and lets the clinician step between AI alert windows.
 */
export function TimelineScrubber({
  durationSeconds,
  cursor,
  onCursorChange,
  windows,
  selectedAlertId,
  onSelectWindow,
  playing,
  onPlayingChange,
  readout,
}: Props) {
  const span = Math.max(1, durationSeconds);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // Playback advances the cursor in real time (1x) until the end of the case.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const next = cursorRef.current + 1;
      if (next >= span) {
        onCursorChange(span);
        onPlayingChange(false);
      } else {
        onCursorChange(next);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [playing, span, onCursorChange, onPlayingChange]);

  const sorted = [...windows].sort((a, b) => a.start - b.start);

  const jump = (dir: -1 | 1) => {
    const next =
      dir === 1
        ? sorted.find((w) => w.start > cursor + 0.5)
        : [...sorted].reverse().find((w) => w.start < cursor - 0.5);
    if (!next) return;
    onSelectWindow(next.alertId);
    onCursorChange(next.start);
  };

  return (
    <section className="panel px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Timeline scrubber</h2>
        <span className="metric-value ml-auto text-sm">{formatClock(cursor)}</span>
        <span className="text-xs text-muted-foreground">/ {formatClock(span)}</span>
      </div>

      {/* Alert window ticks above the slider */}
      <div className="relative mt-3 h-4">
        {sorted.map((w) => (
          <button
            key={`tick-${w.alertId}`}
            type="button"
            title={`${w.title} · ${formatClock(w.start)}${
              w.dataLevel && w.dataLevel !== "ok"
                ? w.dataLevel === "insufficient"
                  ? " · insufficient EEG data"
                  : " · partial data"
                : ""
            }`}
            aria-label={`Jump to ${w.title}`}
            onClick={() => {
              onSelectWindow(w.alertId);
              onCursorChange(w.start);
            }}
            className={`absolute top-0 h-4 rounded-sm ${
              SEVERITY_DOT[w.severity] ?? SEVERITY_DOT["advisory"]
            } ${selectedAlertId === w.alertId ? "ring-2 ring-signal" : "opacity-70"}`}
            style={{
              left: `${Math.min(99, (w.start / span) * 100)}%`,
              width: `${Math.max(0.7, ((w.end - w.start) / span) * 100)}%`,
              ...(w.dataLevel && w.dataLevel !== "ok"
                ? {
                    backgroundImage:
                      "repeating-linear-gradient(45deg, rgba(255,255,255,0.4) 0 2px, transparent 2px 5px)",
                  }
                : {}),
            }}
          />
        ))}
      </div>

      <Slider
        value={[Math.min(span, Math.max(0, cursor))]}
        min={0}
        max={span}
        step={1}
        onValueChange={(v) => {
          onPlayingChange(false);
          onCursorChange(v[0] ?? 0);
        }}
        aria-label="Session review position"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => jump(-1)} disabled={!sorted.length}>
          <ChevronLeft className="size-4" /> Prev alert
        </Button>
        <Button variant="outline" size="sm" onClick={() => onPlayingChange(!playing)}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          {playing ? "Pause" : "Play"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => jump(1)} disabled={!sorted.length}>
          Next alert <ChevronRight className="size-4" />
        </Button>
        {selectedAlertId ? (
          <Button variant="ghost" size="sm" onClick={() => onSelectWindow(null)}>
            <X className="size-4" /> Clear window
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {sorted.length
            ? "Click a marker, an alert card, or drag on the DSA to review that moment."
            : "No alert windows recorded — drag on the DSA to review any moment."}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {readout.map((r) => (
          <div key={r.label} className="rounded-md border border-border px-2 py-1">
            <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
              {r.label}
            </p>
            <p className="metric-value text-sm">{r.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
