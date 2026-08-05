import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BACKDATE_OFFSETS, MARKER_GROUPS } from "@/lib/eeg/marker-presets";
import { QuickMarkBar } from "@/components/monitor/QuickMarkBar";
import type { MarkerMode } from "@/lib/eeg/marker-presets";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

/**
 * One-tap event marking. Presets are grouped the way a case runs, and a
 * back-date control covers the common "I noticed that a minute ago" case.
 */
export function MarkSheet({
  elapsed,
  mode,
  onMark,
  onDone,
}: {
  elapsed: number;
  mode?: MarkerMode;
  onMark: (label: string, backdateSeconds?: number) => void;
  onDone: () => void;
}) {
  const [backdate, setBackdate] = useState<number>(0);
  const [text, setText] = useState("");
  const stamp = Math.max(0, elapsed - backdate);

  function mark(label: string) {
    onMark(label, backdate);
    onDone();
  }

  return (
    <div className="space-y-4">
      {mode ? (
        <div>
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Quick markers · one tap, default timestamp
          </p>
          <QuickMarkBar
            mode={mode}
            elapsed={elapsed}
            running
            size="compact"
            onMark={(label, backdateSeconds) => {
              onMark(label, backdateSeconds);
              onDone();
            }}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Custom timestamp
        </span>
        <div className="flex flex-wrap gap-1.5">
          {BACKDATE_OFFSETS.map((offset) => (
            <button
              key={offset}
              type="button"
              aria-pressed={backdate === offset}
              onClick={() => setBackdate(offset)}
              className={cn(
                "min-h-11 rounded-full border px-3 text-xs font-medium sm:min-h-9",
                backdate === offset
                  ? "border-marker bg-marker/15 text-marker"
                  : "border-border text-muted-foreground",
              )}
            >
              {offset === 0 ? "Now" : `−${offset}s`}
            </button>
          ))}
        </div>
        <span className="metric-value ml-auto text-xs text-muted-foreground">
          marks at {formatClock(stamp)}
        </span>
      </div>

      {MARKER_GROUPS.map((group) => (
        <div key={group.key}>
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {group.label}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {group.markers.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => mark(label)}
                className="min-h-11 rounded-md border border-border px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-marker hover:text-marker"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Input
          value={text}
          placeholder="Custom marker"
          className="h-11 flex-1"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              mark(text.trim());
              setText("");
            }
          }}
        />
        <Button
          className="min-h-11"
          disabled={!text.trim()}
          onClick={() => {
            mark(text.trim());
            setText("");
          }}
        >
          Mark
        </Button>
      </div>
    </div>
  );
}
