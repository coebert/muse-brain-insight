import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Pause, Play, Rewind } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { MUSE_CHANNELS, type MuseChannel } from "@/lib/eeg/muse";
import type { SignalQuality } from "@/lib/eeg/dsp";
import { EPOCH_SECONDS, type DetectedEvent, type Epoch } from "@/lib/eeg/analysis";
import { RAW_ARCHIVE_HZ, type RawArchive } from "@/lib/eeg/raw-archive";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

export interface RawChannelViewerProps {
  archive: RawArchive;
  /** Live only while the case is streaming. */
  streaming: boolean;
  contactOk: Record<string, boolean>;
  channelQuality: Record<string, SignalQuality>;
  /** Analysed epochs — used to shade suppressed periods on the traces. */
  epochs?: Epoch[];
  /** Detector events — seizure suspicions and burst-suppression episodes. */
  events?: DetectedEvent[];
  /**
   * Clinician annotations for the session. Ones written by this viewer are
   * prefixed with the electrode name (e.g. `TP9 · twitching`).
   */
  markers?: DetectedEvent[];
  /** Place a timestamped annotation against one electrode. */
  onAnnotateChannel?: (channel: MuseChannel, tSeconds: number, text: string) => void;
}

/** Splits `TP9 · text` back into the electrode it was placed on. */
function annotationChannel(detail: string): MuseChannel | null {
  const match = /^(TP9|AF7|AF8|TP10)\s·\s/.exec(detail);
  return match ? (match[1] as MuseChannel) : null;
}

/** Annotation pins for one electrode, positioned within the visible window. */
function ChannelNotes({
  notes,
  from,
  to,
}: {
  notes: { t: number; text: string }[];
  from: number;
  to: number;
}) {
  const span = Math.max(0.001, to - from);
  return (
    <div className="pointer-events-none absolute inset-0">
      {notes
        .filter((n) => n.t >= from && n.t <= to)
        .map((n, i) => (
          <div
            key={`${n.t}-${i}`}
            className="absolute inset-y-0 border-l border-dashed border-primary/80"
            style={{ left: `${((n.t - from) / span) * 100}%` }}
            title={`${n.text} · ${formatClock(n.t)}`}
          >
            <span className="absolute bottom-0.5 left-0.5 max-w-[140px] truncate rounded bg-primary/20 px-1 text-[9px] text-primary">
              {n.text}
            </span>
          </div>
        ))}
    </div>
  );
}

/** A detection shaded over the raw traces. */
interface Overlay {
  from: number;
  to: number;
  kind: "seizure" | "suppression";
  label: string;
}

/** Merge touching/overlapping spans of one kind so the shading reads cleanly. */
function mergeSpans(spans: Overlay[]): Overlay[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const out: Overlay[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind && s.from <= last.to + 0.01) {
      last.to = Math.max(last.to, s.to);
    } else out.push({ ...s });
  }
  return out;
}

const OVERLAY_STYLE: Record<Overlay["kind"], { fill: string; edge: string; text: string }> = {
  seizure: {
    fill: "rgba(239,68,68,0.18)",
    edge: "rgba(239,68,68,0.85)",
    text: "rgb(252,165,165)",
  },
  suppression: {
    fill: "rgba(245,190,40,0.16)",
    edge: "rgba(245,190,40,0.85)",
    text: "rgb(250,214,137)",
  },
};

/** Absolutely positioned detection bands drawn over one trace lane. */
function DetectionBands({
  overlays,
  from,
  to,
  showLabels,
}: {
  overlays: Overlay[];
  from: number;
  to: number;
  showLabels: boolean;
}) {
  const span = Math.max(0.001, to - from);
  return (
    <div className="pointer-events-none absolute inset-0">
      {overlays.map((o, i) => {
        const left = ((Math.max(o.from, from) - from) / span) * 100;
        const width = ((Math.min(o.to, to) - Math.max(o.from, from)) / span) * 100;
        if (width <= 0) return null;
        const style = OVERLAY_STYLE[o.kind];
        return (
          <div
            key={`${o.kind}-${o.from}-${i}`}
            className="absolute inset-y-0"
            style={{
              left: `${left}%`,
              width: `${Math.max(width, 0.4)}%`,
              background: style.fill,
              borderLeft: `1px solid ${style.edge}`,
              borderRight: `1px solid ${style.edge}`,
            }}
            title={`${o.label} · ${formatClock(o.from)}–${formatClock(o.to)}`}
          >
            {showLabels ? (
              <span
                className="metric-value absolute left-0.5 top-0.5 whitespace-nowrap text-[9px] font-semibold"
                style={{ color: style.text }}
              >
                {o.label}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
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
  epochs = [],
  events = [],
  markers = [],
  onAnnotateChannel,
}: RawChannelViewerProps) {
  const [live, setLive] = useState(true);
  const [windowSeconds, setWindowSeconds] = useState<number>(10);
  const [gainUv, setGainUv] = useState<number>(100);
  /** Left edge of the review window, seconds from session start. */
  const [cursor, setCursor] = useState(0);
  const [tick, setTick] = useState(0);
  /** Electrode + session time the clinician clicked, awaiting a label. */
  const [pending, setPending] = useState<{ channel: MuseChannel; t: number } | null>(null);
  const [draft, setDraft] = useState("");

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

  // Detections in session time: seizure suspicions from the detector, and
  // suppressed epochs (plus burst-suppression episodes) shaded as periods.
  const detections = useMemo(() => {
    const spans: Overlay[] = [];
    for (const e of events) {
      if (e.kind === "seizure") {
        spans.push({
          from: e.t,
          to: e.t + Math.max(e.duration, EPOCH_SECONDS),
          kind: "seizure",
          label: "Seizure?",
        });
      } else if (e.kind === "burst_suppression" || e.kind === "isoelectric") {
        spans.push({
          from: e.t,
          to: e.t + Math.max(e.duration, EPOCH_SECONDS),
          kind: "suppression",
          label: e.kind === "isoelectric" ? "Isoelectric" : "Burst suppression",
        });
      }
    }
    for (const ep of epochs) {
      if (ep.isSuppressed) {
        spans.push({
          from: Math.max(0, ep.t - EPOCH_SECONDS),
          to: ep.t,
          kind: "suppression",
          label: "Suppressed",
        });
      }
      if (ep.seizureAlert) {
        spans.push({
          from: Math.max(0, ep.t - EPOCH_SECONDS),
          to: ep.t,
          kind: "seizure",
          label: "Seizure?",
        });
      }
    }
    const seizure = mergeSpans(spans.filter((s) => s.kind === "seizure"));
    const suppression = mergeSpans(spans.filter((s) => s.kind === "suppression"));
    return [...suppression, ...seizure];
  }, [epochs, events]);

  const visible = detections.filter((d) => d.to > traces.from && d.from < traces.to);

  // Annotations placed on a specific electrode, grouped per channel.
  const channelNotes = useMemo(() => {
    const byChannel = new Map<MuseChannel, { t: number; text: string }[]>();
    for (const m of markers) {
      const channel = annotationChannel(m.detail);
      if (!channel) continue;
      const list = byChannel.get(channel) ?? [];
      list.push({ t: m.t, text: m.detail.replace(/^\S+\s·\s/, "") });
      byChannel.set(channel, list);
    }
    return byChannel;
  }, [markers]);

  /** Turn a click on a lane into a session time within the visible window. */
  function laneTime(event: ReactMouseEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    const frac = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    return traces.from + Math.max(0, Math.min(1, frac)) * (traces.to - traces.from);
  }

  function commitAnnotation() {
    if (!pending) return;
    const text = draft.trim();
    if (text && onAnnotateChannel) onAnnotateChannel(pending.channel, pending.t, text);
    setPending(null);
    setDraft("");
  }

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
                <div
                  className={cn("relative h-full w-full", onAnnotateChannel && "cursor-crosshair")}
                  onClick={
                    onAnnotateChannel
                      ? (e) => {
                          setPending({ channel, t: laneTime(e) });
                          setDraft("");
                        }
                      : undefined
                  }
                  title={onAnnotateChannel ? `Click to annotate ${channel}` : undefined}
                >
                  <ChannelTrace data={samples} gainUv={gainUv} side={SIDE_OF[channel]} />
                  <DetectionBands
                    overlays={visible}
                    from={traces.from}
                    to={traces.to}
                    showLabels={channel === MUSE_CHANNELS[0]}
                  />
                  <ChannelNotes
                    notes={channelNotes.get(channel) ?? []}
                    from={traces.from}
                    to={traces.to}
                  />
                  {pending?.channel === channel ? (
                    <div
                      className="pointer-events-none absolute inset-y-0 w-px bg-primary"
                      style={{
                        left: `${((pending.t - traces.from) / Math.max(0.001, traces.to - traces.from)) * 100}%`,
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {pending ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-3 py-2 sm:px-4">
          <span className="metric-value text-xs font-semibold">
            {pending.channel} · {formatClock(pending.t)}
          </span>
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitAnnotation();
              if (e.key === "Escape") setPending(null);
            }}
            placeholder="Annotation (e.g. electrode lifted, facial twitching)"
            className="h-9 w-full min-w-0 flex-1 text-xs sm:min-w-[180px]"
            aria-label={`Annotation for ${pending.channel}`}
          />
          <Button size="sm" className="min-h-9 text-xs" onClick={commitAnnotation}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-9 text-xs"
            onClick={() => setPending(null)}
          >
            Cancel
          </Button>
        </div>
      ) : onAnnotateChannel ? (
        <p className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground sm:px-4">
          Click any trace to place a timestamped annotation on that electrode — saved with the
          session.
        </p>
      ) : null}

      {/* Whole-session detection ribbon — where the current window sits. */}
      {span > 0.5 ? (
        <div className="border-t border-border px-3 pt-2 sm:px-4">
          <div className="relative h-3 overflow-hidden rounded-sm bg-[rgb(8,16,34)]">
            <DetectionBands overlays={detections} from={0} to={span} showLabels={false} />
            <div
              className="absolute inset-y-0 border border-primary/70 bg-primary/10"
              style={{
                left: `${(traces.from / Math.max(span, 0.001)) * 100}%`,
                width: `${Math.max((windowSeconds / Math.max(span, 0.001)) * 100, 0.6)}%`,
              }}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-3 rounded-[2px]"
                style={{ background: OVERLAY_STYLE.suppression.fill, border: `1px solid ${OVERLAY_STYLE.suppression.edge}` }}
                aria-hidden
              />
              Burst suppression
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-3 rounded-[2px]"
                style={{ background: OVERLAY_STYLE.seizure.fill, border: `1px solid ${OVERLAY_STYLE.seizure.edge}` }}
                aria-hidden
              />
              Seizure suspicion
            </span>
            <span className="metric-value">
              {detections.filter((d) => d.kind === "seizure").length} seizure ·{" "}
              {detections.filter((d) => d.kind === "suppression").length} suppression episodes
            </span>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 sm:px-4">
        <span className="metric-value text-xs text-muted-foreground">
          {formatClock(traces.from)} – {formatClock(traces.to)}
          {live && streaming ? " · live" : " · review"}
        </span>
        <div className="w-full min-w-0 flex-1 sm:min-w-[180px]">
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