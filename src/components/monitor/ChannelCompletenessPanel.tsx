import { AlertTriangle, CheckCircle2, CircleSlash } from "lucide-react";

import { formatDuration } from "@/lib/eeg/format";
import type { ChannelCompleteness } from "@/lib/eeg/channel-completeness";
import { cn } from "@/lib/utils";

export interface ChannelCompletenessPanelProps {
  rows: ChannelCompleteness[];
  /** Whole-stream completeness (0–1) from the session coverage assessment. */
  streamFraction?: number;
  streamMissingSeconds?: number;
  className?: string;
}

const LEVEL_TEXT = {
  ok: "text-signal",
  partial: "text-caution",
  poor: "text-destructive",
} as const;

const LEVEL_BAR = {
  ok: "bg-signal",
  partial: "bg-caution",
  poor: "bg-destructive",
} as const;

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Per-electrode data completeness so a clinician can see at a glance which
 * contact is missing, flat or noisy — plus the overall Muse stream coverage.
 */
export function ChannelCompletenessPanel({
  rows,
  streamFraction,
  streamMissingSeconds,
  className,
}: ChannelCompletenessPanelProps) {
  const hasData = rows.some((r) => r.epochs > 0);

  return (
    <section className={cn("panel border border-border px-3 py-3", className)} aria-label="Data completeness by channel">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Completeness by channel
        </h3>
        {typeof streamFraction === "number" ? (
          <p className="text-[11px] text-muted-foreground">
            Muse stream {pct(streamFraction)}
            {typeof streamMissingSeconds === "number" && streamMissingSeconds > 0
              ? ` · ${formatDuration(streamMissingSeconds)} missing`
              : ""}
          </p>
        ) : null}
      </div>

      {!hasData ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleSlash className="size-3.5" /> No electrode data yet — connect the headband to start rating contacts.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.channel} className="text-xs">
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 font-mono text-[11px]">{r.channel}</span>
                <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {r.side}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/50">
                  <div
                    className={cn("h-full rounded-full", LEVEL_BAR[r.level])}
                    style={{ width: `${Math.max(2, r.usableFraction * 100)}%` }}
                  />
                </div>
                <span className={cn("w-10 shrink-0 text-right metric-value text-[11px]", LEVEL_TEXT[r.level])}>
                  {pct(r.usableFraction)}
                </span>
                {r.level === "ok" ? (
                  <CheckCircle2 className="size-3.5 shrink-0 text-signal" aria-label="Good" />
                ) : (
                  <AlertTriangle
                    className={cn("size-3.5 shrink-0", LEVEL_TEXT[r.level])}
                    aria-label={r.level === "partial" ? "Intermittent" : "Unusable"}
                  />
                )}
              </div>
              <p className="mt-0.5 pl-[5.5rem] text-[10px] text-muted-foreground">
                {r.note ? `${r.note} · ` : ""}
                flat {pct(r.flatFraction)} · noisy {pct(r.poorFraction)} · EMG {pct(r.meanEmg)}
                {r.worstRunSeconds > 0 ? ` · worst run ${formatDuration(r.worstRunSeconds)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
