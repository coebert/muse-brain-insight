import { useServerFn } from "@tanstack/react-start";
import { Sparkles, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatClock } from "@/lib/eeg/format";
import type { DictatedMarker } from "@/lib/eeg/marker-dictation";
import { parseMarkerDictation } from "@/lib/eeg/marker-dictation.functions";

const TIMING_LABEL: Record<DictatedMarker["timing"], string> = {
  stated: "time stated",
  relative: "relative to now",
  "assumed-now": "assumed now",
};

/**
 * Free-text box read by the AI mid-case: anything typed here is turned into
 * timestamped markers ("rocuronium 40mg given at 1 minute" → a marker at
 * 1:00), shown for a glance-check, then filed onto the recording.
 */
export function DictationMarkBox({
  elapsed,
  onMark,
}: {
  elapsed: number;
  /** Files a marker, back-dated by `backdateSeconds` from the case clock. */
  onMark: (label: string, backdateSeconds?: number) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<DictatedMarker[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);

  const parse = useServerFn(parseMarkerDictation);

  async function read() {
    const note = text.trim();
    if (!note || busy) return;
    setBusy(true);
    try {
      const result = await parse({ data: { text: note, elapsed } });
      setProposed(result.markers);
      setUnmatched(result.unmatched);
      if (!result.markers.length) toast.info("No events found in that note.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The AI could not read that note.");
    } finally {
      setBusy(false);
    }
  }

  function file(marker: DictatedMarker) {
    onMark(marker.label, Math.max(0, Math.round(elapsed - marker.atSeconds)));
    setProposed((prev) => prev.filter((m) => m !== marker));
    toast.success(`Marked “${marker.label}” at ${formatClock(marker.atSeconds)}`);
  }

  function fileAll() {
    for (const marker of proposed) {
      onMark(marker.label, Math.max(0, Math.round(elapsed - marker.atSeconds)));
    }
    toast.success(`${proposed.length} marker${proposed.length === 1 ? "" : "s"} added`);
    setProposed([]);
    setUnmatched([]);
    setText("");
  }

  return (
    <section className="rounded-md border border-border bg-muted/20 p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Sparkles className="size-3.5" /> Type it as you say it · AI adds the markers
      </p>
      <Textarea
        aria-label="Free-text case entry for AI marking"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. rocuronium 40mg given at 1 minute, incision two minutes ago, facial twitching now"
        className="text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button className="min-h-11" disabled={!text.trim() || busy} onClick={() => void read()}>
          {busy ? "Reading…" : "Read and mark"}
        </Button>
        <span className="metric-value ml-auto text-xs text-muted-foreground">
          case clock {formatClock(elapsed)}
        </span>
      </div>

      {proposed.length ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Proposed markers — check the times
          </p>
          {proposed.map((marker, index) => (
            <div
              key={`${marker.label}-${marker.atSeconds}-${index}`}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{marker.label}</p>
                <p className="metric-value text-xs text-muted-foreground">
                  {formatClock(marker.atSeconds)} · {TIMING_LABEL[marker.timing]}
                  {marker.quote ? ` · “${marker.quote}”` : ""}
                </p>
              </div>
              <Button size="sm" className="min-h-9" onClick={() => file(marker)}>
                Add
              </Button>
              <button
                type="button"
                aria-label={`Discard ${marker.label}`}
                className="rounded-md p-2 text-muted-foreground hover:text-foreground"
                onClick={() => setProposed((prev) => prev.filter((m) => m !== marker))}
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
          <Button variant="secondary" className="min-h-11 w-full" onClick={fileAll}>
            Add all {proposed.length}
          </Button>
        </div>
      ) : null}

      {unmatched.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Not marked: {unmatched.join("; ")}
        </p>
      ) : null}
    </section>
  );
}