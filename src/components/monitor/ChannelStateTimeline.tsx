import { useMemo, useState } from "react";

import { MUSE_CHANNELS, type MuseChannel } from "@/lib/eeg/muse";
import {
  channelStateRuns,
  type ChannelState,
  type ChannelStatePoint,
} from "@/lib/eeg/channel-completeness";
import { formatClock } from "@/lib/eeg/format";
import { ParameterInfo } from "@/components/monitor/ParameterInfo";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<ChannelState, { fill: string; label: string }> = {
  good: { fill: "hsl(var(--signal))", label: "Good" },
  fair: { fill: "hsl(var(--caution))", label: "Fair" },
  poor: { fill: "hsl(var(--destructive))", label: "Noisy" },
  flat: { fill: "hsl(var(--muted-foreground))", label: "Flat / off-head" },
  missing: { fill: "hsl(var(--border))", label: "No data" },
};

const SIDE_LABEL: Record<MuseChannel, string> = {
  TP9: "TP9 · left",
  AF7: "AF7 · left",
  AF8: "AF8 · right",
  TP10: "TP10 · right",
};

export interface ChannelStateTimelineProps {
  history: ChannelStatePoint[];
  hopSeconds?: number;
  className?: string;
}

/**
 * Per-electrode state over the case: a colour-coded lane per channel plus an
 * EMG-noise trace, so it is obvious when a signal degraded and when it recovered.
 */
export function ChannelStateTimeline({ history, hopSeconds = 2, className }: ChannelStateTimelineProps) {
  const [hover, setHover] = useState<{ t: number; channel: MuseChannel; state: ChannelState; emg: number } | null>(null);

  const span = useMemo(() => {
    if (!history.length) return { start: 0, end: hopSeconds };
    const start = history[0]!.t;
    const end = Math.max(history[history.length - 1]!.t + hopSeconds, start + hopSeconds);
    return { start, end };
  }, [history, hopSeconds]);

  const width = Math.max(1, span.end - span.start);
  const pct = (seconds: number) => ((seconds - span.start) / width) * 100;

  const lanes = useMemo(
    () =>
      MUSE_CHANNELS.map((channel) => ({
        channel,
        runs: channelStateRuns(history, channel, hopSeconds),
        emg: history.map((p) => ({ t: p.t, v: p.emg[channel] ?? 0 })),
      })),
    [history, hopSeconds],
  );

  const ticks = useMemo(() => {
    const count = 5;
    return Array.from({ length: count + 1 }, (_, i) => span.start + (width * i) / count);
  }, [span.start, width]);

  return (
    <section id="mon-channel-timeline" className={cn("panel scroll-mt-24 p-3", className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Channel state over time
          <ParameterInfo parameter="signalQuality" />
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          {(Object.keys(STATE_STYLE) as ChannelState[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm" style={{ background: STATE_STYLE[s].fill }} />
              {STATE_STYLE[s].label}
            </span>
          ))}
        </div>
      </div>

      {history.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No channel history yet — start streaming to build the timeline.
        </p>
      ) : (
        <div className="space-y-1.5">
          {lanes.map((lane) => (
            <div key={lane.channel} className="flex items-center gap-2">
              <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">{SIDE_LABEL[lane.channel]}</span>
              <div
                className="relative h-7 flex-1 overflow-hidden rounded-sm border border-border bg-muted/20"
                onMouseLeave={() => setHover(null)}
              >
                {lane.runs.map((run, i) => (
                  <div
                    key={i}
                    className="absolute inset-y-0"
                    title={`${SIDE_LABEL[lane.channel]} · ${STATE_STYLE[run.state].label} · ${formatClock(Math.round(run.startSeconds))}–${formatClock(Math.round(run.endSeconds))}`}
                    style={{
                      left: `${pct(run.startSeconds)}%`,
                      width: `${Math.max(0.4, pct(run.endSeconds) - pct(run.startSeconds))}%`,
                      background: STATE_STYLE[run.state].fill,
                      opacity: run.state === "missing" ? 0.5 : 0.85,
                    }}
                    onMouseEnter={() =>
                      setHover({
                        t: run.startSeconds,
                        channel: lane.channel,
                        state: run.state,
                        emg:
                          lane.emg.find((e) => e.t >= run.startSeconds && e.t < run.endSeconds)?.v ?? 0,
                      })
                    }
                  />
                ))}
                {/* EMG contamination trace over the state band. */}
                <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
                  <polyline
                    points={lane.emg
                      .map((e) => `${pct(e.t).toFixed(2)},${(100 - Math.max(0, Math.min(1, e.v)) * 100).toFixed(2)}`)
                      .join(" ")}
                    fill="none"
                    stroke="hsl(var(--foreground))"
                    strokeOpacity={0.55}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </div>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0" />
            <div className="relative flex-1">
              <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
                {ticks.map((t, i) => (
                  <span key={i}>{formatClock(Math.round(t))}</span>
                ))}
              </div>
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground">
            {hover
              ? `${SIDE_LABEL[hover.channel]} · ${STATE_STYLE[hover.state].label} from ${formatClock(Math.round(hover.t))} · EMG ${(hover.emg * 100).toFixed(0)}%`
              : "Thin line = EMG/muscle contamination (higher line = more noise). Hover a band for details."}
          </p>
        </div>
      )}
    </section>
  );
}
