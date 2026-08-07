import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import type { SessionCoverage } from "@/lib/eeg/coverage";
import type { Epoch } from "@/lib/eeg/analysis";
import { ChannelCompletenessPanel } from "@/components/monitor/ChannelCompletenessPanel";
import type { ChannelCompleteness } from "@/lib/eeg/channel-completeness";
import { cn } from "@/lib/utils";
import { MONITOR_JUMP, type MonitorJumpTarget } from "@/lib/monitor-jump";

export interface CaseDetailsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseState: "idle" | "running" | "ended";
  statusLabel: string;
  elapsedSeconds: number;
  epochs: Epoch[];
  coverage: SessionCoverage;
  caseCode?: string | null | undefined;
  sourceName?: string | null | undefined;
  analysisSource?: string | null | undefined;
  connectionError?: string | null | undefined;
  reconnectAttempt?: number | undefined;
  dataGapSeconds?: number | undefined;
  channelCompleteness?: ChannelCompleteness[] | undefined;
  /** Jump to the monitor panel behind a metric or flag. */
  onJump?: ((target: MonitorJumpTarget) => void) | undefined;
}

function Metric({
  label,
  value,
  sub,
  target,
  onJump,
}: {
  label: string;
  value: string;
  sub?: string;
  target?: MonitorJumpTarget;
  onJump?: ((target: MonitorJumpTarget) => void) | undefined;
}) {
  const body = (
    <>
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
        {target && onJump ? <ArrowRight className="size-3 opacity-70" aria-hidden /> : null}
      </p>
      <p className="metric-value text-lg leading-tight">{value}</p>
      {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
    </>
  );
  if (target && onJump) {
    return (
      <button
        type="button"
        onClick={() => onJump(target)}
        title={`Go to ${MONITOR_JUMP[target].label}`}
        className="panel border border-border px-3 py-2 text-left transition-colors hover:border-signal/60 hover:bg-signal/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {body}
      </button>
    );
  }
  return <div className="panel border border-border px-3 py-2">{body}</div>;
}

const num = (v: number | null | undefined, digits = 0, unit = "") =>
  typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : "—";

/**
 * Detail view behind the case status widget: key clinical metrics for the
 * running case plus any data-integrity or connection error flags.
 */
export function CaseDetailsDrawer({
  open,
  onOpenChange,
  caseState,
  statusLabel,
  elapsedSeconds,
  epochs,
  coverage,
  caseCode,
  sourceName,
  analysisSource,
  connectionError,
  reconnectAttempt,
  dataGapSeconds,
  channelCompleteness,
  onJump,
}: CaseDetailsDrawerProps) {
  const live = open && caseState === "running";
  // Re-render once a second while the case runs so elapsed time, the freshness
  // age and every derived metric below stay current without closing the drawer.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const latest = epochs.length ? epochs[epochs.length - 1]! : null;

  // Track when the last epoch actually landed, to show data freshness.
  const stampRef = useRef<{ key: string; at: number }>({ key: "", at: Date.now() });
  const updateKey = `${epochs.length}:${latest?.t ?? -1}`;
  if (stampRef.current.key !== updateKey) stampRef.current = { key: updateKey, at: Date.now() };
  const ageSeconds = Math.max(0, Math.round((nowMs - stampRef.current.at) / 1000));
  const stale = live && ageSeconds > 8;

  const seizureAlerts = epochs.filter((e) => e.seizureAlert).length;
  const poorEpochs = epochs.filter((e) => e.quality.grade === "poor").length;
  const suppressionSeconds = epochs.reduce((a, e) => a + e.epochSuppression * (coverage.cadenceSeconds || 1), 0);

  const flags: { tone: "warn" | "bad"; text: string; target?: MonitorJumpTarget }[] = [];
  if (connectionError) flags.push({ tone: "bad", text: `Connection error: ${connectionError}`, target: "status" });
  if (reconnectAttempt && reconnectAttempt > 0)
    flags.push({ tone: "warn", text: `Reconnecting to headband (attempt ${reconnectAttempt})`, target: "status" });
  if (coverage.level !== "ok")
    flags.push({
      tone: coverage.level === "insufficient" ? "bad" : "warn",
      text: `Data completeness ${(coverage.fraction * 100).toFixed(0)}% — ${formatDuration(coverage.missingSeconds)} missing`,
      target: "channels",
    });
  if (coverage.worstGapSeconds > 0)
    flags.push({
      tone: "warn",
      text: `Longest gap ${formatDuration(coverage.worstGapSeconds)} at ${formatClock(coverage.worstGapAtSeconds)}`,
      target: "dsa",
    });
  if (coverage.missingMetrics.length)
    flags.push({ tone: "warn", text: `Metrics absent for most of the case: ${coverage.missingMetrics.join(", ")}`, target: "metrics" });
  if (dataGapSeconds && dataGapSeconds > 0)
    flags.push({ tone: "warn", text: `Live stream gap of ${formatDuration(dataGapSeconds)}`, target: "dsa" });
  if (epochs.length && poorEpochs / epochs.length > 0.25)
    flags.push({
      tone: "warn",
      text: `${((poorEpochs / epochs.length) * 100).toFixed(0)}% of epochs graded poor signal quality`,
      target: "signal-quality",
    });
  for (const c of channelCompleteness ?? []) {
    if (c.epochs > 0 && c.level !== "ok")
      flags.push({
        tone: c.level === "poor" ? "bad" : "warn",
        text: `${c.channel} (${c.side}) usable for only ${(c.usableFraction * 100).toFixed(0)}% of the case${c.note ? ` — ${c.note.toLowerCase()}` : ""}`,
        target: "raw",
      });
  }
  if (latest?.depthReliability && latest.depthReliability.reliable === false)
    flags.push({
      tone: "warn",
      text: `Depth index currently unreliable${latest.depthReliability.reasons?.length ? ` — ${latest.depthReliability.reasons.join(", ")}` : ""}`,
      target: "signal-quality",
    });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Case details</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
                live
                  ? stale
                    ? "border-caution/50 bg-caution/10 text-caution"
                    : "border-signal/50 bg-signal/10 text-signal"
                  : "border-border text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full bg-current",
                  live && !stale ? "animate-pulse" : "",
                )}
              />
              {live
                ? ageSeconds < 2
                  ? "Live · updating"
                  : `Live · updated ${ageSeconds}s ago`
                : "Snapshot"}
            </span>
            {statusLabel}
            {caseCode ? ` · ${caseCode}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Duration" value={formatClock(elapsedSeconds)} sub={caseState === "running" ? "Live" : "Final"} target="status" onJump={onJump} />
            <Metric
              label="Completeness"
              value={`${(coverage.fraction * 100).toFixed(0)}%`}
              sub={`${coverage.present}/${coverage.expected} epochs`}
              target="channels"
              onJump={onJump}
            />
            <Metric label="Depth index" value={num(latest?.depth?.index, 0)} sub="OpenIBIS-style" target="metrics" onJump={onJump} />
            <Metric label="SEF95" value={num(latest?.sef95, 1, " Hz")} target="dsa" onJump={onJump} />
            <Metric label="Suppression ratio" value={num(latest?.suppressionRatio, 0, " %")} target="metrics" onJump={onJump} />
            <Metric label="Suppression time" value={formatDuration(Math.round(suppressionSeconds))} target="metrics" onJump={onJump} />
            <Metric label="Seizure score" value={num(latest?.seizureScore, 2)} sub={`${seizureAlerts} alert epochs`} target="events" onJump={onJump} />
            <Metric label="Signal quality" value={num(latest ? latest.quality.score * 100 : null, 0, " %")} sub={latest?.quality?.grade ?? "—"} target="signal-quality" onJump={onJump} />
          </div>

          {onJump ? (
            <button
              type="button"
              onClick={() => onJump("event-log")}
              className="panel flex w-full items-center justify-between gap-2 border border-border px-3 py-2 text-left text-xs transition-colors hover:border-signal/60 hover:bg-signal/5"
            >
              <span>Open full event log &amp; markers</span>
              <ArrowRight className="size-3.5 opacity-70" aria-hidden />
            </button>
          ) : null}

          <ChannelCompletenessPanel
            rows={channelCompleteness ?? []}
            streamFraction={coverage.fraction}
            streamMissingSeconds={coverage.missingSeconds}
          />

          <div className="panel border border-border px-3 py-2 text-xs text-muted-foreground">
            <p>Source: {sourceName ?? "—"}</p>
            <p>Analysis side: {analysisSource ?? "combined"}</p>
            <p>Epoch cadence: {coverage.cadenceSeconds}s</p>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Error flags</h3>
            {flags.length === 0 ? (
              <p className="flex items-center gap-2 rounded-md border border-signal/40 bg-signal/10 px-3 py-2 text-xs text-signal">
                <CheckCircle2 className="size-4 shrink-0" /> No data-integrity or connection issues detected.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {flags.map((f, i) => {
                  const jumpable = Boolean(f.target && onJump);
                  const className = cn(
                    "flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-xs",
                    f.tone === "bad"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-caution/40 bg-caution/10 text-caution",
                    jumpable && "transition-colors hover:brightness-125",
                  );
                  return (
                    <li key={i}>
                      {jumpable ? (
                        <button
                          type="button"
                          className={className}
                          onClick={() => onJump!(f.target!)}
                          title={`Go to ${MONITOR_JUMP[f.target!].label}`}
                        >
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1">{f.text}</span>
                          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap font-medium underline-offset-2 hover:underline">
                            {MONITOR_JUMP[f.target!].label}
                            <ArrowRight className="size-3" aria-hidden />
                          </span>
                        </button>
                      ) : (
                        <div className={className}>
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                          <span>{f.text}</span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
