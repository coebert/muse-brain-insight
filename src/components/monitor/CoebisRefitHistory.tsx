/**
 * COEBIS version history: every automatic or manual refit, when it ran, and
 * whether the displayed COEBIS number actually moved. Lets a clinician tell a
 * change in the patient from a change in the model.
 */
import { useEffect, useState } from "react";
import { ArrowRight, History, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  clearCoebisRefitLog,
  readCoebisRefitLog,
  subscribeCoebisRefitLog,
  type CoebisRefitEntry,
} from "@/lib/eeg/coebis-refit-log";

function whenLabel(at: number): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? "unknown time"
    : d.toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function useCoebisRefitLog(): CoebisRefitEntry[] {
  const [entries, setEntries] = useState<CoebisRefitEntry[]>([]);
  useEffect(() => {
    const sync = () => setEntries(readCoebisRefitLog());
    sync();
    return subscribeCoebisRefitLog(sync);
  }, []);
  return entries;
}

export function CoebisRefitHistory({
  className,
  limit,
}: {
  className?: string;
  limit?: number;
}) {
  const entries = useCoebisRefitLog();
  const shown = limit ? entries.slice(0, limit) : entries;

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="size-4 text-muted-foreground" aria-hidden />
          COEBIS version history
        </CardTitle>
        {entries.length ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={clearCoebisRefitLog}
          >
            <Trash2 className="mr-1 size-3.5" aria-hidden />
            Clear
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="pt-0">
        {shown.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No refits recorded yet on this device. Each automatic or manual COEBIS recompute is
            logged here with the time and whether the number changed.
          </p>
        ) : (
          <ul className="divide-y">
            {shown.map((e) => (
              <li key={e.id} className="flex items-start gap-2 py-2">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="tabular-nums">{whenLabel(e.at)}</span>
                    <Badge variant="outline" className="h-4 px-1 text-[11px]">
                      {e.trigger === "auto" ? "auto" : "manual"}
                    </Badge>
                    {e.changed ? (
                      <Badge className="h-4 px-1 text-[11px]">
                        {e.versionBefore ? `v${e.versionBefore} → ` : ""}
                        {e.versionAfter ? `v${e.versionAfter}` : "new fit"}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="h-4 px-1 text-[11px]">
                        unchanged
                      </Badge>
                    )}
                    {e.changed && e.provisional ? (
                      <Badge variant="outline" className="h-4 px-1 text-[11px] text-amber-500">
                        provisional
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {e.changed && e.maxDelta != null && e.maxDelta > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        COEBIS at OpenIBIS 50: {e.valueBefore ?? "—"}
                        <ArrowRight className="size-3" aria-hidden />
                        {e.valueAfter ?? "—"} · up to {e.maxDelta.toFixed(1)} units across 30–70
                      </span>
                    ) : (
                      "COEBIS value unchanged by this refit"
                    )}
                    {e.n != null ? ` · ${e.n} paired readings` : ""}
                    {e.maeAfter != null ? ` · MAE ${e.maeAfter.toFixed(1)}` : ""}
                    {e.biasAfter != null ? ` · bias ${e.biasAfter.toFixed(1)}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
