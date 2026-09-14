import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { formatClock } from "@/lib/eeg/format";
import {
  CASE_PHASES,
  PHASE_DETAIL,
  PHASE_TEXT,
  currentPhase,
  phaseSpans,
  type CaseObservation,
  type CasePhase,
} from "@/lib/eeg/case-observations";
import {
  deleteCaseObservation,
  listCaseObservations,
  recordCaseObservation,
} from "@/lib/eeg/case-observations.functions";
import { cn } from "@/lib/utils";

const TONE: Record<CasePhase, string> = {
  induction: "border-caution/50 text-caution",
  maintenance: "border-signal/40 text-foreground",
  emergence: "border-signal/60 text-signal",
  recovery: "border-signal/40 text-signal",
};

/**
 * Where the case is up to, on the case clock.
 *
 * Kept separate from the patient-state tags on purpose: a phase says what is
 * being done, a state says what the patient is doing. Recording them apart
 * means a case where the two disagree — still unresponsive well into recovery,
 * say — is stored as it happened rather than smoothed over.
 */
export function PhaseTrackerPanel({
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
        if (!cancelled) setRows(result.filter((r) => r.kind === "phase"));
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [caseCode, testing, list]);

  const tag = useCallback(
    async (phase: CasePhase) => {
      setBusy(true);
      try {
        const saved = await record({
          data: {
            caseCode,
            draft: { kind: "phase", atSeconds: Math.round(elapsed), phase },
          },
        });
        setRows((prev) => [...prev, saved].sort((a, b) => a.atSeconds - b.atSeconds));
        toast.success(`${PHASE_TEXT[phase]} from ${formatClock(elapsed)}`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That phase could not be saved.");
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
      toast.error("That phase could not be removed.");
    }
  }

  const now = currentPhase(rows);
  const spans = phaseSpans(rows);

  return (
    <section className="rounded-lg border border-border bg-card/60">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Case phase</h2>
        <p className="text-xs text-muted-foreground">
          {now ? `Now: ${PHASE_TEXT[now]}` : "No phase tagged yet"}
        </p>
      </header>

      {!active ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {testing
            ? "Test session — nothing is recorded. Start a case to track its phases."
            : "Start a case to mark induction, maintenance, emergence and recovery."}
        </p>
      ) : null}

      <div className={cn("px-3 py-3", !active && "pointer-events-none opacity-45")}>
        <p className="instrument-label">Phase from now</p>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {CASE_PHASES.map((phase) => (
            <button
              key={phase}
              type="button"
              disabled={!active || busy}
              onClick={() => void tag(phase)}
              title={PHASE_DETAIL[phase]}
              className={cn(
                "min-h-14 rounded-lg border bg-background/40 px-2 text-xs leading-tight transition-colors hover:bg-background disabled:opacity-40",
                TONE[phase],
                now === phase && "bg-background ring-1 ring-inset ring-current",
              )}
            >
              {PHASE_TEXT[phase]}
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
                (r) => r.atSeconds === span.startSeconds && r.phase === span.phase,
              );
              return (
                <li
                  key={row?.id ?? `${span.phase}-${i}`}
                  className="flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-xs"
                >
                  <span className="metric-value text-muted-foreground">
                    {formatClock(span.startSeconds)}
                    {span.endSeconds == null ? " →" : `–${formatClock(span.endSeconds)}`}
                  </span>
                  <span className="truncate">{PHASE_TEXT[span.phase]}</span>
                  {span.endSeconds != null ? (
                    <span className="text-muted-foreground">
                      {formatClock(span.endSeconds - span.startSeconds)} long
                    </span>
                  ) : null}
                  {row ? (
                    <button
                      type="button"
                      onClick={() => void removeRow(row.id)}
                      className="ml-auto text-muted-foreground hover:text-critical"
                      aria-label={`Remove phase tag at ${formatClock(span.startSeconds)}`}
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
