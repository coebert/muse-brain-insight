import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteCaseObservation,
  listSessionObservations,
  recordCaseObservation,
} from "@/lib/eeg/case-observations.functions";
import { describeObservation, type CaseObservation } from "@/lib/eeg/case-observations";
import { formatClock } from "@/lib/eeg/format";

/** Read "12:30", "750" or "1:02:03" as seconds on the case clock. */
export function parseCaseClock(value: string): number | null {
  const parts = value.trim().split(":");
  if (!parts.length || parts.some((p) => p !== "" && !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => (p === "" ? 0 : Number(p)));
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const KIND_LABEL: Record<CaseObservation["kind"], string> = {
  note: "Note",
  responsiveness: "Responsiveness",
  drug: "Drug",
  event: "Event",
  state: "State",
  phase: "Phase",
};

/**
 * Add notes against points on a filed case's timeline, after the event.
 * Tapping the bar picks the moment; the note is stored on the case clock so it
 * always reads back beside the trace it refers to.
 */
export function CaseTimelineNotes({
  sessionId,
  caseCode,
  durationSeconds,
}: {
  sessionId: string;
  caseCode: string;
  durationSeconds: number;
}) {
  const queryClient = useQueryClient();
  const barRef = useRef<HTMLDivElement | null>(null);
  const [atSeconds, setAtSeconds] = useState<number | null>(null);
  const [timeText, setTimeText] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const total = Math.max(durationSeconds || 0, 1);

  const observations = useQuery({
    queryKey: ["case_observations", "session", sessionId],
    queryFn: () => listSessionObservations({ data: { sessionId } }),
  });

  const rows = observations.data ?? [];

  function pick(seconds: number) {
    const clamped = Math.max(0, Math.min(Math.round(seconds), total));
    setAtSeconds(clamped);
    setTimeText(formatClock(clamped));
  }

  function pickFromBar(clientX: number) {
    const el = barRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const ratio = box.width ? (clientX - box.left) / box.width : 0;
    pick(ratio * total);
  }

  async function save() {
    const typed = parseCaseClock(timeText);
    const seconds = typed ?? atSeconds;
    if (seconds == null) {
      toast.error("Choose a point on the timeline first.");
      return;
    }
    if (!text.trim()) {
      toast.error("Write the note before saving it.");
      return;
    }
    setSaving(true);
    try {
      await recordCaseObservation({
        data: {
          caseCode,
          sessionId,
          draft: { kind: "note", atSeconds: seconds, note: text.trim() },
        },
      });
      setText("");
      setAtSeconds(null);
      setTimeText("");
      toast.success(`Note saved at ${formatClock(seconds)}`);
      await queryClient.invalidateQueries({
        queryKey: ["case_observations", "session", sessionId],
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the note");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await deleteCaseObservation({ data: { id } });
      await queryClient.invalidateQueries({
        queryKey: ["case_observations", "session", sessionId],
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the note");
    }
  }

  return (
    <section className="panel mt-3 px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">Timeline notes</h3>
        <p className="text-xs text-muted-foreground">
          Tap the bar at the moment you mean, then write the note. Keep it anonymised.
        </p>
      </div>

      <div
        ref={barRef}
        role="button"
        tabIndex={0}
        aria-label="Case timeline — tap to choose a moment"
        className="relative mt-3 h-12 w-full cursor-crosshair rounded-md border border-border bg-muted/30"
        onClick={(e) => pickFromBar(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick(atSeconds == null ? 0 : atSeconds + 30);
          }
        }}
      >
        {rows.map((row) => (
          <span
            key={row.id}
            title={`${formatClock(row.atSeconds)} · ${describeObservation(row)}`}
            className={`absolute top-1 bottom-1 w-0.5 ${
              row.kind === "note" ? "bg-signal" : "bg-muted-foreground/50"
            }`}
            style={{ left: `${Math.min(100, (row.atSeconds / total) * 100)}%` }}
          />
        ))}
        {atSeconds != null ? (
          <span
            className="pointer-events-none absolute -top-1 -bottom-1 w-[2px] bg-primary"
            style={{ left: `${Math.min(100, (atSeconds / total) * 100)}%` }}
          />
        ) : null}
        <span className="absolute bottom-0.5 left-1 text-[11px] text-muted-foreground">0:00</span>
        <span className="absolute right-1 bottom-0.5 text-[11px] text-muted-foreground">
          {formatClock(total)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor={`at-${sessionId}`}>
          At
        </label>
        <Input
          id={`at-${sessionId}`}
          value={timeText}
          onChange={(e) => setTimeText(e.target.value)}
          placeholder="mm:ss"
          inputMode="numeric"
          className="h-9 w-24"
        />
        <span className="text-xs text-muted-foreground">into the case</span>
      </div>

      <Textarea
        aria-label="Note at this point in the case"
        className="mt-2"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What happened at this point — anonymised only."
      />
      <Button size="sm" className="mt-2 min-h-9" disabled={saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Add note at this point"}
      </Button>

      <ul className="mt-3 space-y-1.5">
        {rows.length === 0 ? (
          <li className="text-sm text-muted-foreground">Nothing marked on this case yet.</li>
        ) : null}
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-start gap-2 rounded-md border border-border/70 px-2 py-1.5 text-sm"
          >
            <span className="metric-value shrink-0 text-xs text-muted-foreground">
              {formatClock(row.atSeconds)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{KIND_LABEL[row.kind]}</span>
            <span className="min-w-0 flex-1 break-words">{describeObservation(row)}</span>
            {row.kind === "note" ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void remove(row.id)}
              >
                Remove
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
