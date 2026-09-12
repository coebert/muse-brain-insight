import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { formatClock } from "@/lib/eeg/format";
import {
  STATE_LABELS,
  STATE_LABEL_DETAIL,
  STATE_LABEL_TEXT,
  currentState,
  stateSpans,
  type CaseObservation,
  type StateLabel,
} from "@/lib/eeg/case-observations";
import {
  deleteCaseObservation,
  listCaseObservations,
  recordCaseObservation,
} from "@/lib/eeg/case-observations.functions";
import { cn } from "@/lib/utils";

const TONE: Record<StateLabel, string> = {
  awake: "border-signal/60 text-signal",
  sedated_responsive: "border-signal/40 text-foreground",
  sedated_unresponsive: "border-caution/50 text-caution",
  anaesthetised: "border-caution/60 text-caution",
  burst_suppression: "border-critical/60 text-critical",
  emergence: "border-signal/50 text-signal",
};

/**
 * One tap to say what the patient is doing right now. Each tag holds until the
 * next one, so a case reads as a sequence of labelled stretches — the same
 * vocabulary the external corpora use, so bedside cases can be graded beside
 * them without translation.
 */
export function StateMarkerPanel({
  caseCode,
  elapsed,
  running,
  testing,
  onRowsChange,
}: {
  caseCode: string;
  elapsed: number;
  running: boolean;
  testing: boolean;
  onRowsChange?: (rows: CaseObservation[]) => void;
}) {
  const record = useServerFn(recordCaseObservation);
  const list = useServerFn(listCaseObservations);
  const remove = useServerFn(deleteCaseObservation);

  const [rows, setRows] = useState<CaseObservation[]>([]);
  const [busy, setBusy] = useState(false);

  const active = running && !testing && Boolean(caseCode.trim());

  useEffect(() => {
    onRowsChange?.(rows);
  }, [rows, onRowsChange]);

  useEffect(() => {
    if (!caseCode.trim() || testing) {
      setRows([]);
      return;
    }
    let cancelled = false;
    void list({ data: { caseCode } })
      .then((result) => {
        if (!cancelled) setRows(result.filter((r) => r.kind === "state"));
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [caseCode, testing, list]);

  const tag = useCallback(
    async (label: StateLabel) => {
      setBusy(true);
      try {
        const saved = await record({
          data: {
            caseCode,
            draft: { kind: "state", atSeconds: Math.round(elapsed), stateLabel: label },
          },
        });
        setRows((prev) => [...prev, saved].sort((a, b) => a.atSeconds - b.atSeconds));
        toast.success(`${STATE_LABEL_TEXT[label]} from ${formatClock(elapsed)}`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That tag could not be saved.");
      } finally {
        setBusy(false);
      }
    },
    [caseCode, elapsed, record],
  );

  async function removeRow(id: string) {
    const before = rows;
    setRows((prev) => prev.filter((r) => r.id !== id));
    try {
      await remove({ data: { id } });
    } catch {
      setRows(before);
      toast.error("That tag could not be removed.");
    }
  }

  const now = currentState(rows);
  const spans = stateSpans(rows);

  return (
    <section className="rounded-lg border border-border bg-card/60">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Patient state</h2>
        <p className="text-xs text-muted-foreground">
          {now ? `Now: ${STATE_LABEL_TEXT[now]}` : "No state tagged yet"}
        </p>
      </header>

      {!active ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {testing
            ? "Test session — nothing is recorded. Start a case to tag the patient's state."
            : "Start a case to tag awake, unresponsive and the rest against the case clock."}
        </p>
      ) : null}

      <div className={cn("px-3 py-3", !active && "pointer-events-none opacity-45")}>
        <p className="instrument-label">State from now</p>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {STATE_LABELS.map((label) => (
            <button
              key={label}
              type="button"
              disabled={!active || busy}
              onClick={() => void tag(label)}
              title={STATE_LABEL_DETAIL[label]}
              className={cn(
                "min-h-14 rounded-lg border bg-background/40 px-2 text-xs leading-tight transition-colors hover:bg-background disabled:opacity-40",
                TONE[label],
                now === label && "bg-background ring-1 ring-inset ring-current",
              )}
            >
              {STATE_LABEL_TEXT[label]}
            </button>
          ))}
        </div>
      </div>

      {spans.length ? (
        <ul className="max-h-44 space-y-1 overflow-y-auto border-t border-border px-3 py-2">
          {spans
            .slice()
            .reverse()
            .map((span, i) => {
              const row = rows.find(
                (r) => r.atSeconds === span.startSeconds && r.stateLabel === span.label,
              );
              return (
                <li
                  key={row?.id ?? `${span.label}-${i}`}
                  className="flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-xs"
                >
                  <span className="metric-value text-muted-foreground">
                    {formatClock(span.startSeconds)}
                    {span.endSeconds == null ? " →" : `–${formatClock(span.endSeconds)}`}
                  </span>
                  <span className="truncate">{STATE_LABEL_TEXT[span.label]}</span>
                  <span className="text-muted-foreground">
                    {span.responsive ? "responding" : "not responding"}
                  </span>
                  {row ? (
                    <button
                      type="button"
                      onClick={() => void removeRow(row.id)}
                      className="ml-auto text-muted-foreground hover:text-critical"
                      aria-label={`Remove state tag at ${formatClock(span.startSeconds)}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </li>
              );
            })}
        </ul>
      ) : null}
    </section>
  );
}
