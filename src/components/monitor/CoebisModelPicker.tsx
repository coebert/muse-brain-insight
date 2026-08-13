/**
 * Shows which COEBIS fit produced the number currently on screen and lets the
 * clinician pin an earlier fit so the same recording can be read through an
 * older model for comparison. Pinning is display-only: the live model keeps
 * syncing underneath and releasing the pin returns to it immediately.
 */
import { Check, History, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CoebisFitBadge } from "@/components/monitor/CoebisFitBadge";
import { computeCoebisFitQuality } from "@/lib/eeg/coebis-fit-quality";
import { coebisVersionLabel, useCoebisModelVersions } from "@/hooks/useCoebisModel";
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
  const { active, latest, pinned, versions, loading, select } = useCoebisModelVersions();

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