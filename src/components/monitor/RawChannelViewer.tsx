import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Rewind } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { MUSE_CHANNELS, type MuseChannel } from "@/lib/eeg/muse";
import type { SignalQuality } from "@/lib/eeg/dsp";
import { RAW_ARCHIVE_HZ, type RawArchive } from "@/lib/eeg/raw-archive";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

export interface RawChannelViewerProps {
  archive: RawArchive;
  /** Live only while the case is streaming. */
  streaming: boolean;
  contactOk: Record<string, boolean>;
  channelQuality: Record<string, SignalQuality>;
}

const CHANNEL_SITES: Record<MuseChannel, string> = {
  TP9: "Left ear (temporal)",
  AF7: "Left forehead (frontal)",
  AF8: "Right forehead (frontal)",
  TP10: "Right ear (temporal)",
};

const SIDE_OF: Record<MuseChannel, "L" | "R"> = { TP9: "L", AF7: "L", AF8: "R", TP10: "R" };

const WINDOWS = [4, 10, 30, 60] as const;
const GAINS = [25, 50, 100, 200] as const;

/** One electrode's trace, drawn on a canvas with a µV grid. */
const ChannelTrace = memo(function ChannelTrace({
  data,
  gainUv,
  side,
}: {
  data: Float32Array;
  gainUv: number;
  side: "L" | "R";
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Baseline + ± gain gridlines.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (const frac of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, h * frac);
      ctx.lineTo(w, h * frac);
      ctx.stroke();
    }

    if (!data.length) return;
    const scale = h / 2 / gainUv;
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeStyle = side === "L" ? "rgb(56,214,175)" : "rgb(110,170,255)";
    ctx.beginPath();
    // Min/max decimation keeps spikes visible when samples outnumber pixels.
    const pxCount = Math.max(1, Math.floor(w));
    const per = data.length / pxCount;
    if (per > 2) {
      for (let px = 0; px < pxCount; px++) {
        const start = Math.floor(px * per);
        const end = Math.min(data.length, Math.floor((px + 1) * per));
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = start; i < end; i++) {
          const v = data[i] as number;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (lo === Infinity) continue;
        const clamp = (v: number) => Math.max(-gainUv, Math.min(gainUv, v));
        ctx.moveTo(px, h / 2 - clamp(hi) * scale);
        ctx.lineTo(px, h / 2 - clamp(lo) * scale);
      }
    } else {
      for (let i = 0; i < data.length; i++) {
        const x = (i / Math.max(1, data.length - 1)) * w;
        const v = Math.max(-gainUv, Math.min(gainUv, data[i] as number));
        const y = h / 2 - v * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }, [data, gainUv, side]);

  return <canvas ref={ref} className="h-full w-full" />;
});

/**
 * Raw per-electrode EEG review: four independent traces (TP9, AF7, AF8, TP10)
 * that can be watched live or scrubbed back through the whole recorded
 * session, with adjustable time base and µV gain.
 */
export function RawChannelViewer({
  archive,
  streaming,
  contactOk,
  channelQuality,
}: RawChannelViewerProps) {
  const [live, setLive] = useState(true);
  const [windowSeconds, setWindowSeconds] = useState<number>(10);
  const [gainUv, setGainUv] = useState<number>(100);
  /** Left edge of the review window, seconds from session start. */
  const [cursor, setCursor] = useState(0);
  const [tick, setTick] = useState(0);

  // Redraw at 5 Hz while live; while reviewing the picture is static.
  useEffect(() => {
    if (!live || !streaming) return;
    const id = setInterval(() => setTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, [live, streaming]);

  const span = archive.span();
  const maxCursor = Math.max(0, span - windowSeconds);

  const traces = useMemo(() => {
    const from = live ? Math.max(0, span - windowSeconds) : Math.min(cursor, maxCursor);
    const to = from + windowSeconds;
    return {
      from,
      to,
      data: MUSE_CHANNELS.map((c) => ({ channel: c, samples: archive.read(c, from, to) })),
    };
    // `tick` and `span` drive the live refresh.
  }, [archive, live, span, windowSeconds, cursor, maxCursor, tick]);

  const empty = span < 0.5;

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2.5 sm:px-4">
        <h2 className="text-sm font-semibold">Raw EEG · per electrode</h2>
        <span className="metric-value text-xs text-muted-foreground">
          0.5–45 Hz, 50 Hz notch · {RAW_ARCHIVE_HZ} Hz · ±{gainUv} µV
        </span>
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <Button
            size="sm"
            variant={live ? "default" : "outline"}
            className="min-h-9 gap-1.5 text-xs"
            onClick={() => {
              setLive(true);
              setCursor(maxCursor);
            }}
            disabled={!streaming}
          >
            <Play className="size-3.5" /> Live
          </Button>
          <Button
            size="sm"
            variant={live ? "outline" : "default"}
            className="min-h-9 gap-1.5 text-xs"
            onClick={() => {
              setCursor(maxCursor);
              setLive(false);
            }}
          >
            {streaming ? <Pause className="size-3.5" /> : <Rewind className="size-3.5" />} Review
          </Button>
          <div className="flex overflow-hidden rounded-md border border-border">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowSeconds(w)}
                className={cn(
                  "metric-value px-2 py-1.5 text-xs",
                  windowSeconds === w
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                {w}s
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-md border border-border">
            {GAINS.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGainUv(g)}
                className={cn(
                  "metric-value px-2 py-1.5 text-xs",
                  gainUv === g
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                ±{g}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="divide-y divide-border">
        {traces.data.map(({ channel, samples }) => {
          const q = channelQuality[channel];
          return (
            <div key={channel} className="flex items-stretch gap-2 px-2 py-1.5 sm:px-3">
              <div className="w-28 shrink-0 self-center">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      contactOk[channel] ? "bg-signal" : "bg-muted-foreground/50",
                    )}
                    aria-hidden
                  />
                  <span className="metric-value text-xs font-semibold">{channel}</span>
                  <span className="metric-value text-[10px] text-muted-foreground">
                    {SIDE_OF[channel]}
                  </span>
                </div>
                <p className="text-[10px] leading-tight text-muted-foreground">
                  {CHANNEL_SITES[channel]}
                </p>
                {q ? (
                  <p className="metric-value text-[10px] text-muted-foreground">
                    SQI {(q.score * 100).toFixed(0)}% · {q.grade}
                  </p>
                ) : null}
              </div>
              <div className="h-[72px] min-w-0 flex-1 bg-[rgb(8,16,34)]">
                <ChannelTrace data={samples} gainUv={gainUv} side={SIDE_OF[channel]} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 sm:px-4">
        <span className="metric-value text-xs text-muted-foreground">
          {formatClock(traces.from)} – {formatClock(traces.to)}
          {live && streaming ? " · live" : " · review"}
        </span>
        <div className="min-w-[180px] flex-1">
          <Slider
            aria-label="Scrub raw EEG"
            min={0}
            max={Math.max(1, Math.round(maxCursor))}
            step={1}
            value={[Math.round(live ? maxCursor : Math.min(cursor, maxCursor))]}
            onValueChange={([v]) => {
              setLive(false);
              setCursor(v ?? 0);
            }}
            disabled={empty || maxCursor <= 0}
          />
        </div>
        <span className="metric-value text-xs text-muted-foreground">
          {formatClock(span)} recorded
        </span>
      </div>

      {empty ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          No raw EEG buffered yet — connect the headband or start the demo signal.
        </p>
      ) : null}
    </div>
  );
}