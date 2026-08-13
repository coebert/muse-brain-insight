/**
 * Shows which COEBIS fit produced the number currently on screen and lets the
 * clinician pin an earlier fit so the same recording can be read through an
 * older model for comparison. Pinning is display-only: the live model keeps
 * syncing underneath and releasing the pin returns to it immediately.
 */
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, History, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CoebisFitBadge } from "@/components/monitor/CoebisFitBadge";
import { computeCoebisFitQuality } from "@/lib/eeg/coebis-fit-quality";
import { coebisVersionLabel, useCoebisModelVersions } from "@/hooks/useCoebisModel";
import { getLatestBisAlignment, syncBisAlignment } from "@/lib/eeg/bis-alignment";
import { getBisDrift } from "@/lib/eeg/bis-drift.functions";
import type { BisAlignment } from "@/lib/eeg/depth";

function fittedLabel(model: BisAlignment): string {
  const d = new Date(model.fittedAt);
  return Number.isNaN(d.getTime())
    ? "unknown date"
    : d.toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function metricsLabel(model: BisAlignment): string {
  const parts: string[] = [`${model.n} paired readings`];
  if (typeof model.biasAfter === "number") parts.push(`bias ${model.biasAfter.toFixed(1)}`);
  if (typeof model.maeAfter === "number") parts.push(`MAE ${model.maeAfter.toFixed(1)}`);
  const q = computeCoebisFitQuality(model);
  if (q.inFitPercent != null) parts.push(`~${q.inFitPercent}% in ±5`);
  return parts.join(" · ");
}

export function CoebisModelPicker({ className }: { className?: string }) {
  const { active, latest, pinned, versions, loading, select, reload } = useCoebisModelVersions();
  const refit = useCoebisRefit(reload);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={className}
          aria-label="COEBIS model version"
        >
          <History className="mr-1.5 size-3.5" aria-hidden />
          COEBIS {coebisVersionLabel(active)}
          <CoebisFitBadge model={active} className="ml-1.5" compact />
          {pinned ? (
            <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[11px]">
              pinned
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">COEBIS model version</p>
          <p className="text-xs text-muted-foreground">
            {active
              ? `Displayed numbers come from ${coebisVersionLabel(active)} · ${metricsLabel(active)}`
              : "No fitted model yet — COEBIS matches OpenIBIS."}
          </p>
        </div>

        <div className="border-b p-2">
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            disabled={refit.running}
            onClick={() => void refit.run()}
          >
            {refit.running ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="mr-1.5 size-3.5" aria-hidden />
            )}
            Recompute COEBIS now
          </Button>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Refits from every paired commercial BIS reading already logged, and applies the result
            straight away if it improves agreement.
          </p>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {loading ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">Loading versions…</p>
          ) : versions.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              No fits stored yet. COEBIS versions appear once paired commercial BIS readings have
              been entered.
            </p>
          ) : (
            versions.map((v) => {
              const selected = v.id === active?.id;
              const isLatest = v.id === latest?.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => select(v.id ?? null)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/60"
                  aria-pressed={selected}
                >
                  <Check
                    className={`mt-0.5 size-3.5 shrink-0 ${selected ? "opacity-100" : "opacity-0"}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm">
                      {coebisVersionLabel(v)}
                      {isLatest ? (
                        <Badge variant="secondary" className="h-4 px-1 text-[11px]">
                          latest
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {fittedLabel(v)} · {metricsLabel(v)}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {pinned ? (
          <div className="border-t p-2">
            <Button size="sm" variant="ghost" className="w-full" onClick={() => select(null)}>
              <RotateCcw className="mr-1.5 size-3.5" aria-hidden />
              Back to latest model
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Manual COEBIS refit. The pooled fit normally runs on its own schedule, so
 * after entering a batch of paired readings a clinician can be left looking at
 * a stale number; this recomputes it on demand from the data already logged
 * and reports plainly whether the model changed.
 */
export function useCoebisRefit(onDone?: () => void | Promise<void>) {
  const fetchDrift = useServerFn(getBisDrift);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (running) return;
    setRunning(true);
    const before = getLatestBisAlignment()?.id ?? null;
    try {
      const report = await fetchDrift({});
      const model = await syncBisAlignment();
      await onDone?.();
      if (report.justApplied || (model?.id && model.id !== before)) {
        toast.success(
          `COEBIS refitted — ${coebisVersionLabel(model)} from ${model?.n ?? report.analysis.n} paired readings${
            model?.provisional ? " (provisional)" : ""
          }.`,
        );
      } else if (model) {
        toast.info(
          `No change: ${coebisVersionLabel(model)} still gives the best agreement across ${report.analysis.n} paired readings.`,
        );
      } else {
        toast.info(report.analysis.summary);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not recompute COEBIS.");
    } finally {
      setRunning(false);
    }
  };

  return { running, run };
}