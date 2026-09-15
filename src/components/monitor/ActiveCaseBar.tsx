import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  CircleDot,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  WifiOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCaseSession } from "@/components/monitor/CaseSessionProvider";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

type LiveStatus = {
  label: string;
  detail: string | null;
  icon: typeof Activity;
  tone: "live" | "warn" | "bad" | "idle";
  pulse: boolean;
};

/**
 * One unambiguous answer to "what is the case doing right now?" — link state
 * first, then whether epochs are actually being recorded.
 */
export function describeLiveStatus(input: {
  status: string;
  caseRunning: boolean;
  hasUnfiledData: boolean;
  reconnectAttempt: { attempt: number; attempts: number } | null;
  dataGapSeconds: number;
  sourceName: string | null;
  epochs: number;
}): LiveStatus {
  const source = input.sourceName ? ` · ${input.sourceName}` : "";
  if (input.status === "connecting") {
    return { label: "Connecting", detail: input.sourceName, icon: Loader2, tone: "warn", pulse: true };
  }
  if (input.status === "reconnecting") {
    return {
      label: "Reconnecting",
      detail: input.reconnectAttempt
        ? `attempt ${input.reconnectAttempt.attempt} of ${input.reconnectAttempt.attempts}`
        : "link lost — retrying",
      icon: WifiOff,
      tone: "bad",
      pulse: true,
    };
  }
  if (input.status === "error") {
    return { label: "Disconnected", detail: "signal lost — reconnect the headband", icon: AlertTriangle, tone: "bad", pulse: false };
  }
  if (input.status === "streaming") {
    if (input.dataGapSeconds >= 3) {
      return {
        label: "Connected · no data",
        detail: `gap ${Math.round(input.dataGapSeconds)}s`,
        icon: AlertTriangle,
        tone: "warn",
        pulse: true,
      };
    }
    return {
      label: input.caseRunning ? "Recording" : "Connected",
      detail: input.caseRunning ? `${input.epochs} epochs${source}` : "case not started",
      icon: input.caseRunning ? CircleDot : PlugZap,
      tone: input.caseRunning ? "live" : "warn",
      pulse: input.caseRunning,
    };
  }
  return {
    label: input.caseRunning ? "Paused — not connected" : "Case ended",
    detail: input.caseRunning
      ? "no input source"
      : input.hasUnfiledData
        ? "not filed yet"
        : "filed",
    icon: input.caseRunning ? AlertTriangle : Activity,
    tone: input.caseRunning ? "warn" : "idle",
    pulse: false,
  };
}

const TONE: Record<LiveStatus["tone"], string> = {
  live: "border-signal/40 bg-signal/10 text-signal",
  warn: "border-caution/40 bg-caution/10 text-caution",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
  idle: "border-border bg-muted/40 text-muted-foreground",
};

const DOT: Record<LiveStatus["tone"], string> = {
  live: "bg-signal",
  warn: "bg-caution",
  bad: "bg-destructive",
  idle: "bg-muted-foreground",
};

/**
 * Persistent reminder that a case is still recording while the clinician is on
 * another page, with one tap back to the monitor.
 */
export function ActiveCaseBar() {
  const { caseState, caseRunning, monitor, meta, hasUnfiledData, requestNewCase } = useCaseSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [retrying, setRetrying] = useState(false);

  if (caseState === "idle" || pathname === "/") return null;

  const live = describeLiveStatus({
    status: monitor.status,
    caseRunning,
    hasUnfiledData,
    reconnectAttempt: monitor.reconnectAttempt ?? null,
    dataGapSeconds: monitor.dataGapSeconds ?? 0,
    sourceName: monitor.sourceName ?? null,
    epochs: monitor.epochs.length,
  });
  const Icon = live.icon;
  // A dropped link never ends the case: offer a retry that keeps the data.
  const canReconnect =
    caseRunning && (monitor.status === "error" || monitor.status === "idle");

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs sm:px-4",
        TONE[live.tone],
      )}
    >
      <span className="relative flex size-2.5 shrink-0 items-center justify-center">
        {live.pulse ? (
          <span className={cn("absolute inline-flex size-2.5 animate-ping rounded-full opacity-60", DOT[live.tone])} />
        ) : null}
        <span className={cn("relative inline-flex size-2 rounded-full", DOT[live.tone])} />
      </span>
      <Icon className={cn("size-4 shrink-0", live.icon === Loader2 && "animate-spin")} />
      <span className="font-semibold">{live.label}</span>
      {live.detail ? (
        <span className="truncate text-[11px] opacity-80">{live.detail}</span>
      ) : null}
      <span className="hidden h-3 w-px bg-current/30 sm:block" />
      {meta.caseCode ? <span className="metric-value truncate">{meta.caseCode}</span> : null}
      <span className="metric-value">{formatClock(monitor.elapsed)}</span>
      {canReconnect ? (
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto min-h-8"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await monitor.reconnect();
            } finally {
              setRetrying(false);
            }
          }}
        >
          <RefreshCw className={retrying ? "size-4 animate-spin" : "size-4"} />
          {retrying ? "Reconnecting…" : "Reconnect"}
        </Button>
      ) : null}
      {canReconnect ? (
        <Button
          size="sm"
          variant="secondary"
          className="min-h-8"
          onClick={() => void monitor.repairHeadband()}
        >
          Re-pair
        </Button>
      ) : null}
      {caseState === "ended" ? (
        <Button size="sm" variant="secondary" className="min-h-8" onClick={() => requestNewCase()}>
          <Plus className="size-4" /> New case
        </Button>
      ) : null}
      <Button asChild size="sm" variant="secondary" className={cn("min-h-8", caseState !== "ended" && !canReconnect && "ml-auto")}>
        <Link to="/">Back to monitor</Link>
      </Button>
    </div>
  );
}
