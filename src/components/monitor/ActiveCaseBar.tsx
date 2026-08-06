import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, CircleStop } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCaseSession } from "@/components/monitor/CaseSessionProvider";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

/**
 * Persistent reminder that a case is still recording while the clinician is on
 * another page, with one tap back to the monitor.
 */
export function ActiveCaseBar() {
  const { caseState, caseRunning, streaming, monitor, meta, hasUnfiledData } = useCaseSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (caseState === "idle" || pathname === "/") return null;

  return (
    <div
      className={cn(
        "sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs sm:px-4",
        caseRunning
          ? "border-signal/40 bg-signal/10 text-signal"
          : "border-caution/40 bg-caution/10 text-caution",
      )}
    >
      <Activity className="size-4 shrink-0" />
      <span className="font-semibold">
        {caseRunning
          ? streaming
            ? "Case recording"
            : "Case running"
          : hasUnfiledData
            ? "Case ended — not filed yet"
            : "Case ended"}
      </span>
      {meta.caseCode ? <span className="metric-value truncate">{meta.caseCode}</span> : null}
      <span className="metric-value">{formatClock(monitor.elapsed)}</span>
      <span className="metric-value hidden sm:inline">{monitor.epochs.length} epochs</span>
      <Button asChild size="sm" variant="secondary" className="ml-auto min-h-8">
        <Link to="/">
          {caseRunning ? <CircleStop className="size-4" /> : null} Back to monitor
        </Link>
      </Button>
    </div>
  );
}
