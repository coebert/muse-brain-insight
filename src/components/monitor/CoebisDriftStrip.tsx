import { useMemo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { TrendLine } from "@/components/monitor/TrendLine";
import { BASELINE_SAMPLES, coebisBaseline, coebisDriftSeries } from "@/lib/eeg/coebis-baseline";
import { cn } from "@/lib/utils";

/** Drift past this many points is treated as a recalibration flag. */
export const RECALIBRATION_DRIFT = 15;
/** Vertical span of the strip, in COEBIS points either side of baseline. */
const DRIFT_SPAN = 30;

/**
 * Compact "drift vs baseline" strip for the BIS capture panel. High drift means
 * this patient has moved a long way from where their own COEBIS started, which
 * is exactly the moment a paired commercial reading is worth most: it lets the
 * model refit a patient-adjusted correction rather than leaning on the pooled one.
 */
export function CoebisDriftStrip({
  series,
  action,
  className,
}: {
  /** COEBIS values in case order, oldest first, gaps as null. */
  series: (number | null)[];
  /** Optional capture button rendered inside the recalibration flag. */
  action?: ReactNode;
  className?: string;
}) {
  const baseline = useMemo(() => coebisBaseline(series), [series]);
  const drift = baseline.delta;
  const driftSeries = useMemo(
    () => coebisDriftSeries(series.slice(-600), baseline.value),
    [series, baseline.value],
  );
  const label =
    drift == null ? "—" : `${drift > 0 ? "+" : drift < 0 ? "−" : "±"}${Math.abs(drift).toFixed(0)}`;
  const tone =
    drift == null
      ? "text-muted-foreground"
      : Math.abs(drift) >= RECALIBRATION_DRIFT
        ? "text-critical"
        : Math.abs(drift) >= 8
          ? "text-caution"
          : "text-muted-foreground";
  const flagged = drift != null && Math.abs(drift) >= RECALIBRATION_DRIFT;

  if (series.every((v) => v == null)) return null;

  return (
    <div className={cn("rounded-lg border border-border p-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
          COEBIS drift vs baseline
        </span>
        <span className="metric-value text-xs text-muted-foreground">
          {baseline.value != null ? (
            <>
              base {Math.round(baseline.value)} ·{" "}
              <span className={cn("metric-value", tone)}>{label}</span> pts
            </>
          ) : (
            `establishing baseline ${baseline.samples}/${BASELINE_SAMPLES}`
          )}
        </span>
      </div>
      <div className="mt-1 h-[40px]">
        <TrendLine
          values={driftSeries}
          min={-DRIFT_SPAN}
          max={DRIFT_SPAN}
          band={[-5, 5]}
          color="rgb(200,150,255)"
          unit=" pts"
          height={40}
        />
      </div>
      {flagged ? (
        <div className="mt-2 flex flex-wrap items-start gap-2 rounded-md border border-critical/40 bg-critical/10 p-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-critical" />
          <div className="min-w-[12rem] flex-1">
            <p className="text-xs font-semibold">
              Drift {label} pts — patient-adjusted recalibration due
            </p>
            <p className="text-[11px] text-muted-foreground">
              COEBIS has moved well away from this patient&apos;s own baseline. A paired commercial
              reading now lets the model refit a patient-adjusted correction instead of relying on
              the pooled one.
            </p>
          </div>
          {action}
        </div>
      ) : null}
    </div>
  );
}
