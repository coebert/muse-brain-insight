import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatClock } from "@/lib/eeg/format";
import {
  COMMON_DRUGS,
  DOSE_UNITS,
  EVENT_DETAIL,
  EVENT_LABEL,
  EVENT_TYPES,
  MOAAS_SCALE,
  ROUTES,
  ROUTE_LABEL,
  captureGaps,
  describeObservation,
  sortObservations,
  transitionsOf,
  type CaseObservation,
  type EventType,
  type ObservationDraft,
  type Stimulus,
} from "@/lib/eeg/case-observations";
import {
  deleteCaseObservation,
  listCaseObservations,
  recordCaseObservation,
} from "@/lib/eeg/case-observations.functions";

import { cn } from "@/lib/utils";

/**
 * The stimulus each score is defined by, so a one-tap score still records how
 * it was elicited and can be audited later.
 */
const STIMULUS_FOR_SCORE: Record<number, Stimulus> = {
  5: "name",
  4: "name",
  3: "loud",
  2: "shake",
  1: "trapezius",
  0: "trapezius",
};

const TONE_FOR_SCORE: Record<number, string> = {
  5: "border-signal/60 text-signal",
  4: "border-signal/40 text-foreground",
  3: "border-border text-foreground",
  2: "border-caution/50 text-caution",
  1: "border-critical/50 text-critical",
  0: "border-critical/70 text-critical",
};

/**
 * Bedside capture of the two things the model cannot infer: what the patient
 * did when spoken to, and what they were given. Each entry is filed the moment
 * it is tapped, stamped at the case clock, so nothing depends on remembering
 * it afterwards.
 */
export function ClinicalCapturePanel({
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
  /** Lets the reactivity panel read the same entries without a second fetch. */
  onRowsChange?: (rows: CaseObservation[]) => void;
}) {
  const record = useServerFn(recordCaseObservation);
  const list = useServerFn(listCaseObservations);
  const remove = useServerFn(deleteCaseObservation);

  const [rows, setRows] = useState<CaseObservation[]>([]);
  const [busy, setBusy] = useState(false);
  const [drugName, setDrugName] = useState<string>(COMMON_DRUGS[0]);
  const [dose, setDose] = useState("");
  const [doseUnit, setDoseUnit] = useState<string>("mg");
  const [route, setRoute] = useState<string>("iv-bolus");

  const active = running && !testing && Boolean(caseCode.trim());

  useEffect(() => {
    onRowsChange?.(rows);
  }, [rows, onRowsChange]);


  // Reload whenever the case identity changes, so a second case never shows
  // the first one's entries.
  useEffect(() => {
    if (!caseCode.trim() || testing) {
      setRows([]);
      return;
    }
    let cancelled = false;
    void list({ data: { caseCode } })
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [caseCode, testing, list]);

  const file = useCallback(
    async (draft: ObservationDraft) => {
      setBusy(true);
      try {
        const saved = await record({ data: { caseCode, draft } });
        setRows((prev) => sortObservations([...prev, saved]));
        return saved;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That entry could not be saved.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [caseCode, record],
  );

  async function scoreTapped(score: number) {
    const saved = await file({
      kind: "responsiveness",
      atSeconds: Math.round(elapsed),
      moaas: score,
      stimulus: STIMULUS_FOR_SCORE[score]!,
    });
    if (saved) toast.success(`MOAA/S ${score} recorded at ${formatClock(elapsed)}`);
  }

  async function drugGiven() {
    const parsed = dose.trim() === "" ? null : Number(dose);
    if (parsed != null && (!Number.isFinite(parsed) || parsed <= 0)) {
      toast.error("Enter a dose greater than zero, or leave it blank.");
      return;
    }
    const saved = await file({
      kind: "drug",
      atSeconds: Math.round(elapsed),
      drugName,
      dose: parsed,
      doseUnit: parsed == null ? null : doseUnit,
      route,
    });
    if (saved) {
      setDose("");
      toast.success(`${drugName} recorded at ${formatClock(elapsed)}`);
    }
  }

  async function removeRow(id: string) {
    const before = rows;
    setRows((prev) => prev.filter((r) => r.id !== id));
    try {
      await remove({ data: { id } });
    } catch {
      setRows(before);
      toast.error("That entry could not be removed.");
    }
  }

  const transitions = transitionsOf(rows);
  const gaps = captureGaps(rows);

  return (
    <section className="rounded-lg border border-border bg-card/60">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Clinical record</h2>
        <p className="text-xs text-muted-foreground">
          Responsiveness and drugs, stamped at {formatClock(elapsed)}
        </p>
      </header>

      {!active ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {testing
            ? "Test session — nothing is recorded. Start a case to capture responsiveness and drugs."
            : "Start a case to capture responsiveness scores and drugs against the case clock."}
        </p>
      ) : null}

      <div className={cn("space-y-3 px-3 py-3", !active && "pointer-events-none opacity-45")}>
        {/* One tap per observation: no typing, no menus. */}
        <div>
          <p className="instrument-label">Responsiveness now (MOAA/S)</p>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
            {MOAAS_SCALE.map((step) => (
              <button
                key={step.score}
                type="button"
                disabled={!active || busy}
                onClick={() => void scoreTapped(step.score)}
                title={step.detail}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center rounded-lg border bg-background/40 px-1 py-1.5 transition-colors hover:bg-background disabled:opacity-40",
                  TONE_FOR_SCORE[step.score],
                )}
              >
                <span className="metric-value text-xl tabular-nums">{step.score}</span>
                <span className="text-[10px] leading-tight text-muted-foreground">
                  {step.short}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Drug, dose, route — the record that lets an atypical agent be read. */}
        <div>
          <p className="instrument-label">Drug given now</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Select value={drugName} onValueChange={setDrugName}>
              <SelectTrigger className="h-11 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMON_DRUGS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={dose}
              onChange={(e) => setDose(e.target.value)}
              inputMode="decimal"
              placeholder="Dose"
              aria-label="Dose"
              className="h-11 w-[84px]"
            />
            <Select value={doseUnit} onValueChange={setDoseUnit}>
              <SelectTrigger className="h-11 w-[124px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOSE_UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={route} onValueChange={setRoute}>
              <SelectTrigger className="h-11 w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROUTES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROUTE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="min-h-11"
              disabled={!active || busy}
              onClick={() => void drugGiven()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Record
            </Button>
          </div>
        </div>
      </div>

      {/* What has been captured, and what is still missing while there is time. */}
      {rows.length ? (
        <div className="border-t border-border px-3 py-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Lost responsiveness:{" "}
              <span className="metric-value text-foreground">
                {transitions.lossOfResponsivenessAt == null
                  ? "—"
                  : formatClock(transitions.lossOfResponsivenessAt)}
              </span>
            </span>
            <span>
              Returned:{" "}
              <span className="metric-value text-foreground">
                {transitions.returnOfResponsivenessAt == null
                  ? "—"
                  : formatClock(transitions.returnOfResponsivenessAt)}
              </span>
            </span>
            <span>
              Deepest score:{" "}
              <span className="metric-value text-foreground">
                {transitions.lowestScore ?? "—"}
              </span>
            </span>
          </div>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {sortObservations(rows)
              .slice()
              .reverse()
              .map((row) => (
                <li
                  key={row.id}
                  className="flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-xs"
                >
                  <span className="metric-value text-muted-foreground">
                    {formatClock(row.atSeconds)}
                  </span>
                  <span className="truncate">{describeObservation(row)}</span>
                  <button
                    type="button"
                    onClick={() => void removeRow(row.id)}
                    className="ml-auto text-muted-foreground hover:text-critical"
                    aria-label={`Remove entry at ${formatClock(row.atSeconds)}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      {active && gaps.length ? (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Still to capture: {gaps.join(" · ")}
        </p>
      ) : null}
    </section>
  );
}
