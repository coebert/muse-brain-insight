import { useState } from "react";
import { Activity, CheckCircle2, ChevronRight, CircleSlash, Clock, FileCheck, Radio } from "lucide-react";

import { CaseDetailsDrawer } from "@/components/monitor/CaseDetailsDrawer";
import type { ChannelCompleteness } from "@/lib/eeg/channel-completeness";

import { formatClock, formatDuration } from "@/lib/eeg/format";
import { assessSessionCoverage, type CoverageEpoch } from "@/lib/eeg/coverage";
import { cn } from "@/lib/utils";
import type { Epoch } from "@/lib/eeg/analysis";

export interface CaseStatusWidgetProps {
  caseState: "idle" | "running" | "ended";
  elapsedSeconds: number;
  epochs: Epoch[];
  caseCode?: string | null;
  sourceName?: string | null;
  streaming?: boolean;
  reconnecting?: boolean;
  analysisSource?: string | null | undefined;
  connectionError?: string | null | undefined;
  reconnectAttempt?: number | undefined;
  dataGapSeconds?: number | undefined;
  channelCompleteness?: ChannelCompleteness[] | undefined;
}

const STATUS: Record<CaseStatusWidgetProps["caseState"], { label: string; Icon: typeof Activity; tone: keyof typeof TONE }> = {
  idle: { label: "No case running", Icon: CircleSlash, tone: "idle" },
  running: { label: "Recording", Icon: Radio, tone: "live" },
  ended: { label: "Case ended", Icon: FileCheck, tone: "warn" },
};

const TONE = {
  live: "border-signal/40 bg-signal/10 text-signal",
  warn: "border-caution/40 bg-caution/10 text-caution",
  idle: "border-border bg-muted/40 text-muted-foreground",
};

const BAR = {
  live: "bg-signal",
  warn: "bg-caution",
  idle: "bg-muted-foreground",
};

function toCoverageEpochs(epochs: Epoch[]): CoverageEpoch[] {
  return epochs.map((e) => ({
    t: e.t,
    depth: e.depth?.index ?? null,
    sef95: e.sef95 ?? null,
    sr: e.suppressionRatio ?? null,
    seizure: e.seizureScore ?? null,
    entropy: e.entropy?.state ?? null,
    spectrumBins: e.spectrum?.length ?? 0,
  }));
}

/**
 * Compact at-a-glance dashboard card: case status, elapsed time and data
 * completeness. Designed to sit at the top of the monitor so a clinician can
 * see it without scrolling.
 */
export function CaseStatusWidget({
  caseState,
  elapsedSeconds,
  epochs,
  caseCode,
  sourceName,
  streaming,
  reconnecting,
  analysisSource,
  connectionError,
  reconnectAttempt,
  dataGapSeconds,
  channelCompleteness,
}: CaseStatusWidgetProps) {
  const [open, setOpen] = useState(false);
  const status = STATUS[caseState];
  const Icon = status.Icon;
  const coverage = assessSessionCoverage(toCoverageEpochs(epochs), elapsedSeconds);
  const fraction = Math.max(0, Math.min(1, coverage.fraction));

  const statusLabel = reconnecting
    ? "Reconnecting"
    : streaming
      ? "Streaming"
      : caseState === "running"
        ? "Recording · no stream"
        : status.label;

  return (
    <>
    <button
      className={cn(
        "panel flex w-full flex-col gap-3 border px-3 py-3 text-left transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between sm:px-4",
        TONE[status.tone],
      )}
      aria-label="Case status — open case details"
      aria-haspopup="dialog"
      type="button"
      onClick={() => setOpen(true)}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative flex size-9 shrink-0 items-center justify-center rounded-full border border-current/30 bg-background/60">
          {caseState === "running" && streaming ? (
            <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-current opacity-60" />
          ) : null}
          <Icon className="relative size-4.5" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h2 className="text-sm font-semibold">{statusLabel}</h2>
            {caseCode ? (
              <span className="truncate rounded bg-background/60 px-1.5 py-0.5 text-[11px]">{caseCode}</span>
            ) : null}
          </div>
          <p className="truncate text-xs opacity-80">
            {caseState === "idle"
              ? "Start a case to begin monitoring"
              : sourceName
                ? `Source: ${sourceName}`
                : `${(coverage.present)} epochs · ${formatDuration(coverage.missingSeconds)} missing`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center sm:gap-6">
        <div className="flex items-center gap-2">
          <Clock className="size-4 opacity-70" />
          <div>
            <p className="metric-value text-base leading-none">{formatClock(elapsedSeconds)}</p>
            <p className="text-[10px] uppercase tracking-wide opacity-70">Duration</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {coverage.level === "ok" ? (
            <CheckCircle2 className="size-4 opacity-70" />
          ) : (
            <Activity className="size-4 opacity-70" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="metric-value text-base leading-none">{(fraction * 100).toFixed(0)}%</p>
              <p className="text-[10px] uppercase tracking-wide opacity-70">Completeness</p>
            </div>
            <div className="mt-1.5 h-1.5 w-full min-w-[80px] overflow-hidden rounded-full bg-background/60">
              <div
                className={cn("h-full rounded-full", BAR[status.tone])}
                style={{ width: `${Math.max(2, fraction * 100)}%` }}
              />
            </div>
          </div>
        </div>
        <ChevronRight className="hidden size-4 opacity-60 sm:block" aria-hidden />
      </div>
    </button>

    <CaseDetailsDrawer
      open={open}
      onOpenChange={setOpen}
      caseState={caseState}
      statusLabel={statusLabel}
      elapsedSeconds={elapsedSeconds}
      epochs={epochs}
      coverage={coverage}
      caseCode={caseCode}
      sourceName={sourceName}
      analysisSource={analysisSource}
      connectionError={connectionError}
      reconnectAttempt={reconnectAttempt}
      dataGapSeconds={dataGapSeconds}
      channelCompleteness={channelCompleteness}
    />
    </>
  );
}
