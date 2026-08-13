import { Activity, Loader2, Moon, PlugZap, RefreshCw, Unplug } from "lucide-react";

import type { ConnectionStatusView } from "@/lib/eeg/connection-status";
import { cn } from "@/lib/utils";

const TONE: Record<ConnectionStatusView["state"], string> = {
  idle: "border-border text-muted-foreground",
  ended: "border-border text-muted-foreground",
  connecting: "border-signal/40 text-muted-foreground",
  streaming: "border-signal/50 text-signal",
  sleeping: "border-caution/60 text-caution",
  reconnecting: "border-caution/60 text-caution",
  lost: "border-critical/60 text-critical",
};

const ICON: Record<ConnectionStatusView["state"], typeof Activity> = {
  idle: PlugZap,
  ended: PlugZap,
  connecting: Loader2,
  streaming: Activity,
  sleeping: Moon,
  reconnecting: RefreshCw,
  lost: Unplug,
};

/**
 * One unambiguous link state next to the battery reading, so a silent headband
 * can never be mistaken for a streaming one.
 */
export function ConnectionStatusBadge({
  status,
  className,
}: {
  status: ConnectionStatusView;
  className?: string;
}) {
  const Icon = ICON[status.state];
  const spinning = status.state === "connecting" || status.state === "reconnecting";
  return (
    <span
      role="status"
      aria-label={`Headband connection: ${status.label}`}
      title={status.detail}
      className={cn(
        "metric-value inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
        TONE[status.state],
        className,
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", spinning && "animate-spin")} aria-hidden />
      <span className="max-w-[12rem] truncate">{status.label}</span>
    </span>
  );
}
