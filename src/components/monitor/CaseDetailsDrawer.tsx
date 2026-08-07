import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import type { SessionCoverage } from "@/lib/eeg/coverage";
import type { Epoch } from "@/lib/eeg/analysis";
import { cn } from "@/lib/utils";

export interface CaseDetailsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseState: "idle" | "running" | "ended";
  statusLabel: string;
  elapsedSeconds: number;
  epochs: Epoch[];
  coverage: SessionCoverage;
  caseCode?: string | null;
  sourceName?: string | null;
  analysisSource?: string | null;
  connectionError?: string | null;
  reconnectAttempt?: number;
  dataGapSeconds?: number;
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel border border-border px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="metric-value text-lg leading-tight">{value}</p>
      {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

const num = (v: number | null | undefined, digits = 0, unit = "") =>
  typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : "—";

/**
 * Detail view behind the case status widget: key clinical metrics for the
 * running case plus any data-integrity or connection error flags.
 */
export function CaseDetailsDrawer({
  open,
  onOpenChange,
  caseState,
  statusLabel,
  elapsedSeconds,
  epochs,
  coverage,
  caseCode,
  sourceName,
  analysisSource,
  connectionError,
  reconnectAttempt,
  dataGapSeconds,
}: CaseDetailsDrawerProps) {
  const latest = epochs.length ? epochs[epochs.length - 1]! : null;
  const seizureAlerts = epochs.filter((e) => e.seizureAlert).length;
  const poorEpochs = epochs.filter((e) => e.quality.grade === "poor").length;
  const suppressionSeconds = epochs.reduce((a, e) => a + e.epochSuppression * (coverage.cadenceSeconds || 1), 0);

  const flags: { tone: "warn" | "bad"; text: string }[] = [];
  if (connectionError) flags.push({ tone: "bad", text: `Connection error: ${connectionError}` });
  if (reconnectAttempt && reconnectAttempt > 0)
    flags.push({ tone: "warn", text: `Reconnecting to headband (attempt ${reconnectAttempt})` });
  if (coverage.level !== "ok")
    flags.push({
      tone: coverage.level === "insufficient" ? "bad" : "warn",
      text: `Data completeness ${(coverage.fraction * 100).toFixed(0)}% — ${formatDuration(coverage.missingSeconds)} missing`,
    });
  if (coverage.worstGapSeconds > 0)
    flags.push({
      tone: "warn",
      text: `Longest gap ${formatDuration(coverage.worstGapSeconds)} at ${formatClock(coverage.worstGapAtSeconds)}`,
    });
  if (coverage.missingMetrics.length)
    flags.push({ tone: "warn", text: `Metrics absent for most of the case: ${coverage.missingMetrics.join(", ")}` });
  if (dataGapSeconds && dataGapSeconds > 0)
    flags.push({ tone: "warn", text: `Live stream gap of ${formatDuration(dataGapSeconds)}` });
  if (epochs.length && poorEpochs / epochs.length > 0.25)
    flags.push({
      tone: "warn",
      text: `${((poorEpochs / epochs.length) * 100).toFixed(0)}% of epochs graded poor signal quality`,
    });
  if (latest?.depthReliability && latest.depthReliability.reliable === false)
    flags.push({
      tone: "warn",
      text: `Depth index currently unreliable${latest.depthReliability.reasons?.length ? ` — ${latest.depthReliability.reasons.join(", ")}` : ""}`,
    });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Case details</SheetTitle>
          <SheetDescription>
            {statusLabel}
            {caseCode ? ` · ${caseCode}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Duration" value={formatClock(elapsedSeconds)} sub={caseState === "running" ? "Live" : "Final"} />
            <Metric
              label="Completeness"
              value={`${(coverage.fraction * 100).toFixed(0)}%`}
              sub={`${coverage.present}/${coverage.expected} epochs`}
            />
            <Metric label="Depth index" value={num(latest?.depth?.index, 0)} sub="OpenIBIS-style" />
            <Metric label="SEF95" value={num(latest?.sef95, 1, " Hz")} />
            <Metric label="Suppression ratio" value={num(latest?.suppressionRatio, 0, " %")} />
            <Metric label="Suppression time" value={formatDuration(Math.round(suppressionSeconds))} />
            <Metric label="Seizure score" value={num(latest?.seizureScore, 2)} sub={`${seizureAlerts} alert epochs`} />
            <Metric label="Signal quality" value={num(latest?.quality?.score, 0, " %")} sub={latest?.quality?.grade ?? "—"} />
          </div>

          <div className="panel border border-border px-3 py-2 text-xs text-muted-foreground">
            <p>Source: {sourceName ?? "—"}</p>
            <p>Analysis side: {analysisSource ?? "combined"}</p>
            <p>Epoch cadence: {coverage.cadenceSeconds}s</p>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Error flags</h3>
            {flags.length === 0 ? (
              <p className="flex items-center gap-2 rounded-md border border-signal/40 bg-signal/10 px-3 py-2 text-xs text-signal">
                <CheckCircle2 className="size-4 shrink-0" /> No data-integrity or connection issues detected.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {flags.map((f, i) => (
                  <li
                    key={i}
                    className={cn(
                      "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
                      f.tone === "bad"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-caution/40 bg-caution/10 text-caution",
                    )}
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
