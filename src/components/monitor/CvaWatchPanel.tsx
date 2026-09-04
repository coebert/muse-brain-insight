import { useMemo } from "react";
import { AlertTriangle, Brain, ShieldCheck } from "lucide-react";

import type { HemiSpectra, SqiPoint } from "@/hooks/useEegMonitor";
import { detectCva, type CvaEpochInput, type CvaReport } from "@/lib/eeg/cva-detector";
import { cn } from "@/lib/utils";

interface Props {
  /** Per-epoch left/right spectra, oldest first. */
  hemiSpectra: HemiSpectra[];
  /** Per-epoch signal quality, same cadence as the spectra. */
  sqiHistory: SqiPoint[];
  /** True when the device has electrodes on both sides. */
  bilateral: boolean;
}

/**
 * Watches for a sudden one-sided loss of EEG that sensor contact cannot
 * explain — the electrical signature of acute cortical ischaemia, and the
 * reason EEG is monitored during carotid cross-clamping.
 */
export function CvaWatchPanel({ hemiSpectra, sqiHistory, bilateral }: Props) {
  const report: CvaReport = useMemo(() => {
    const inputs: CvaEpochInput[] = hemiSpectra.map((h, i) => {
      const sqi = sqiHistory[i];
      return {
        t: sqi?.t ?? i,
        left: h.left,
        right: h.right,
        leftSqi: sqi?.left ?? null,
        rightSqi: sqi?.right ?? null,
        emg: sqi?.emg ?? null,
      };
    });
    return detectCva(inputs);
  }, [hemiSpectra, sqiHistory]);

  if (!bilateral) {
    return (
      <section className="panel px-3 py-3 sm:px-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Brain className="size-4 text-muted-foreground" /> Stroke watch
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This headband has sensors on one side only, so left cannot be compared with right.
        </p>
      </section>
    );
  }

  const finding = report.finding;
  const alerting = report.status === "alert";
  const watching = report.status === "watch";

  return (
    <section
      className={cn(
        "panel px-3 py-3 sm:px-4",
        alerting && "border-critical ring-1 ring-critical",
        watching && "border-caution",
      )}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {alerting ? (
            <AlertTriangle className="size-4 text-critical" />
          ) : watching ? (
            <AlertTriangle className="size-4 text-caution" />
          ) : (
            <ShieldCheck className="size-4 text-signal" />
          )}
          Stroke watch · left vs right
        </h2>
        <span
          className={cn(
            "metric-value ml-auto rounded-full px-2 py-0.5 text-xs",
            alerting
              ? "bg-critical/15 text-critical"
              : watching
                ? "bg-caution/15 text-caution"
                : "bg-muted text-muted-foreground",
          )}
        >
          {alerting
            ? `One-sided loss · ${finding?.side === "left" ? "LEFT" : "RIGHT"}`
            : watching
              ? "Watching"
              : report.status === "baselining"
                ? "Learning baseline"
                : "Symmetric"}
        </span>
      </div>

      <p className={cn("mt-1.5 text-sm", alerting ? "text-critical" : "text-muted-foreground")}>
        {report.note}
      </p>

      {finding ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {finding.reasons.map((reason) => (
            <li key={reason}>· {reason}</li>
          ))}
          <li>· started {Math.round(finding.durationSeconds)} s ago</li>
        </ul>
      ) : null}

      {report.baseline ? (
        <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: "Balance now", value: `${fmt(latestAsymmetry(report))} %` },
            { label: "Baseline balance", value: `${fmt(report.baseline.asymmetry)} %` },
            { label: "Learned over", value: `${report.baseline.epochs} epochs` },
            { label: "Calls after", value: `${report.settings.sustainSeconds} s` },
          ].map((item) => (
            <div key={item.label} className="rounded-md bg-muted/40 px-2 py-1.5">
              <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">
                {item.label}
              </dt>
              <dd className="metric-value text-sm">{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <p className="mt-3 text-[11px] text-muted-foreground">
        Advisory pattern detection, not a diagnosis. It compares each side with its own earlier
        self and stays silent when the falling side's contact quality has fallen too. It has not
        been validated against imaging-confirmed strokes.
      </p>
    </section>
  );
}

function latestAsymmetry(report: CvaReport): number {
  for (let i = report.points.length - 1; i >= 0; i--) {
    const point = report.points[i]!;
    if (point.usable) return point.asymmetry;
  }
  return 0;
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(0) : "—";
}
