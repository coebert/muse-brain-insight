import { AlertTriangle, CheckCircle2, CircleSlash } from "lucide-react";

import type { SessionCoverage } from "@/lib/eeg/coverage";
import { formatClock, formatDuration } from "@/lib/eeg/format";

const LEVEL_STYLE: Record<
  SessionCoverage["level"],
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  ok: {
    label: "Complete",
    className: "text-signal border-signal/40 bg-signal/10",
    Icon: CheckCircle2,
  },
  partial: {
    label: "Partial data",
    className: "text-caution border-caution/40 bg-caution/10",
    Icon: AlertTriangle,
  },
  insufficient: {
    label: "Insufficient data",
    className: "text-critical border-critical/40 bg-critical/10",
    Icon: CircleSlash,
  },
};

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border/60 px-3 py-2">
      <p className="text-xs tracking-[0.16em] text-muted-foreground uppercase">{label}</p>
      <p className="metric-value text-base leading-tight">{value}</p>
      {sub ? <p className="truncate text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/**
 * Session-level data completeness: stored-epoch coverage, the worst recording
 * gap and how many AI alert windows were flagged with missing evidence.
 */
export function SessionCoverageSummary({
  coverage,
  incompleteAlerts,
  totalAlerts,
  settings,
}: {
  coverage: SessionCoverage;
  incompleteAlerts: number;
  totalAlerts: number;
  /** Optional threshold-settings control rendered in the header. */
  settings?: React.ReactNode;
}) {
  const style = LEVEL_STYLE[coverage.level];
  const Icon = style.Icon;

  return (
    <section className="panel px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Data completeness</h2>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${style.className}`}
          >
            <Icon className="size-3.5" />
            {style.label}
          </span>
          {settings}
        </div>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={
            coverage.level === "insufficient"
              ? "h-full bg-critical"
              : coverage.level === "partial"
                ? "h-full bg-caution"
                : "h-full bg-signal"
          }
          style={{ width: `${Math.max(2, coverage.fraction * 100)}%` }}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Cell
          label="Coverage"
          value={`${(coverage.fraction * 100).toFixed(1)} %`}
          sub={`${coverage.present} of ${coverage.expected} epochs`}
        />
        <Cell
          label="Worst gap"
          value={coverage.worstGapSeconds > 0 ? formatDuration(coverage.worstGapSeconds) : "none"}
          sub={
            coverage.worstGapSeconds > 0
              ? `at t ${formatClock(coverage.worstGapAtSeconds)}`
              : `${coverage.cadenceSeconds.toFixed(1)} s cadence`
          }
        />
        <Cell
          label="Missing time"
          value={coverage.missingSeconds > 0 ? formatDuration(coverage.missingSeconds) : "0 s"}
          sub={
            coverage.spectrumMissingFraction > 0
              ? `${(coverage.spectrumMissingFraction * 100).toFixed(0)} % epochs without spectrum`
              : "spectra stored throughout"
          }
        />
        <Cell
          label="Incomplete alerts"
          value={totalAlerts ? `${incompleteAlerts} / ${totalAlerts}` : "—"}
          sub={totalAlerts ? "windows with partial or missing data" : "no AI alerts for this case"}
        />
      </div>

      {coverage.missingMetrics.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Metrics missing for most of the session: {coverage.missingMetrics.join(", ")}.
        </p>
      ) : null}
    </section>
  );
}
