/**
 * The small line at the top of an analysis screen saying when its numbers were
 * last worked out, and offering to work them out again.
 */
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { describeAge, type CachedAnalysis } from "@/lib/eeg/analysis-cache";

interface Props {
  meta: CachedAnalysis<unknown> | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** What the screen calls the thing being worked out, e.g. "the dashboard". */
  label?: string;
}

export function CacheStatusBar({ meta, refreshing, onRefresh, label = "these numbers" }: Props) {
  const age = describeAge(meta?.computedAt ?? null);
  const rows = meta?.rowsScanned ?? 0;
  const seconds = meta?.durationMs ? Math.max(1, Math.round(meta.durationMs / 1000)) : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-2.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {meta?.computedAt ? (
            <>
              Worked out <span className="text-foreground">{age}</span>
            </>
          ) : (
            <span className="text-foreground">Working {label} out for the first time</span>
          )}
        </span>
        {rows > 0 && <span>· {rows.toLocaleString()} readings</span>}
        {seconds != null && <span>· took {seconds}s</span>}
        {refreshing && (
          <span className="flex items-center gap-1.5 text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> working out a fresh set
          </span>
        )}
        {meta?.error && !refreshing && (
          <span className="text-destructive">· last attempt failed: {meta.error}</span>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
        Work out again
      </Button>
    </div>
  );
}
