/**
 * Automatic drift flag for a COEBIS model: whether the residual distribution
 * has shifted, or the share of readings within tolerance has fallen away, on
 * the most recent cases compared with the readings behind the fit.
 */
import { AlertTriangle, CheckCircle2, Info, TrendingDown } from "lucide-react";

import type { CoebisDriftStatus, CoebisDriftWatch } from "@/lib/eeg/coebis-drift-watch";

const TONE: Record<CoebisDriftStatus, { chip: string; panel: string; label: string }> = {
  insufficient: {
    chip: "bg-muted text-muted-foreground",
    panel: "border-border",
    label: "Drift watch: warming up",
  },
  stable: {
    chip: "bg-signal/15 text-signal",
    panel: "border-border",
    label: "Drift watch: stable",
  },
  watch: {
    chip: "bg-caution/15 text-caution",
    panel: "border-caution/60",
    label: "Drift watch: slipping",
  },
  drifting: {
    chip: "bg-critical/15 text-critical",
    panel: "border-critical/60",
    label: "Drift detected",
  },
};

function StatusIcon({ status }: { status: CoebisDriftStatus }) {
  if (status === "drifting") return <AlertTriangle className="size-4 text-critical" aria-hidden />;
  if (status === "watch") return <TrendingDown className="size-4 text-caution" aria-hidden />;
  if (status === "stable") return <CheckCircle2 className="size-4 text-signal" aria-hidden />;
  return <Info className="size-4 text-muted-foreground" aria-hidden />;
}

/** Compact chip for tables and headers. */
export function CoebisDriftChip({ drift }: { drift: CoebisDriftWatch }) {
  const tone = TONE[drift.status];
  return (
    <span
      title={drift.summary}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${tone.chip}`}
    >
      {drift.status === "insufficient"
        ? "—"
        : drift.status === "stable"
          ? "stable"
          : drift.status === "watch"
            ? "slipping"
            : "drifted"}
    </span>
  );
}

/** Full alert block with the windows the decision was made on. */
export function CoebisDriftAlert({
  drift,
  title,
}: {
  drift: CoebisDriftWatch;
  title?: string | undefined;
}) {
  const tone = TONE[drift.status];
  const win = (w: CoebisDriftWatch["baseline"]) =>
    w.n
      ? `${w.percentWithin}% within ±${drift.tolerance} · bias ${w.bias == null ? "—" : `${w.bias > 0 ? "+" : ""}${w.bias}`} · MAE ${w.mae ?? "—"} · n ${w.n}`
      : "no readings";

  return (
    <section
      className={`panel border p-3 ${tone.panel}`}
      role={drift.status === "drifting" ? "alert" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusIcon status={drift.status} />
        <h3 className="text-sm font-semibold">{title ?? tone.label}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${tone.chip}`}>{tone.label}</span>
      </div>
      <p className="mt-2 text-xs">{drift.summary}</p>

      {drift.reasons.length > 1 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {drift.reasons.slice(1).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-md bg-muted/40 px-2.5 py-2">
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
            Earlier readings
          </p>
          <p className="metric-value text-xs">{win(drift.baseline)}</p>
        </div>
        <div className="rounded-md bg-muted/40 px-2.5 py-2">
          <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
            Recent readings
          </p>
          <p className="metric-value text-xs">{win(drift.recent)}</p>
        </div>
      </div>

      <p className="mt-2 metric-value text-[11px] text-muted-foreground">
        Change in within-tolerance{" "}
        {drift.percentDelta == null
          ? "—"
          : `${drift.percentDelta > 0 ? "+" : ""}${drift.percentDelta} pts`}{" "}
        · residual shift{" "}
        {drift.biasDelta == null
          ? "—"
          : `${drift.biasDelta > 0 ? "+" : ""}${drift.biasDelta} points`}{" "}
        · histogram stability index {drift.psi == null ? "—" : drift.psi.toFixed(2)}
      </p>
    </section>
  );
}
