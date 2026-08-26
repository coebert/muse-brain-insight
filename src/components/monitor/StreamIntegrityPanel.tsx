import { Activity, AlertTriangle, CheckCircle2, CircleSlash, Timer } from "lucide-react";

import { formatDuration } from "@/lib/eeg/format";
import type { IntegritySnapshot, SuppressionClock } from "@/lib/eeg/stream-integrity";
import { cn } from "@/lib/utils";

export interface StreamIntegrityPanelProps {
  integrity: IntegritySnapshot | null;
  clock: SuppressionClock | null;
  className?: string;
}

const GRADE_TEXT = {
  good: "text-signal",
  fair: "text-caution",
  poor: "text-destructive",
} as const;

const GRADE_LABEL = {
  good: "Link healthy",
  fair: "Link degraded",
  poor: "Link unreliable",
} as const;

const num = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : "–");

function Metric({
  label,
  value,
  unit,
  recent,
  hint,
  alert,
}: {
  label: string;
  value: string;
  unit: string;
  recent: string;
  hint: string;
  alert: boolean;
}) {
  return (
    <div className="rounded-md border border-border/70 px-2.5 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-mono text-lg leading-tight tabular-nums",
          alert ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
        <span className="ml-1 text-[11px] font-sans text-muted-foreground">{unit}</span>
      </p>
      <p className="text-[11px] text-muted-foreground">last 60 s: {recent}</p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">{hint}</p>
    </div>
  );
}

/**
 * Bedside data-quality read-out: what the radio link is actually delivering,
 * and whether the suppression timer is counting only analysed, valid seconds.
 */
export function StreamIntegrityPanel({ integrity, clock, className }: StreamIntegrityPanelProps) {
  const hasStream = !!integrity && integrity.totals.samples > 0;
  const grade = integrity?.grade ?? "good";
  const coveragePct = clock ? Math.round(clock.coverage * 100) : 0;
  const excluded = clock ? clock.excludedArtifactSeconds + clock.excludedGapSeconds : 0;

  return (
    <section
      className={cn("panel border border-border px-3 py-3", className)}
      aria-label="Real-time data quality"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Data quality (live)
        </h3>
        {hasStream ? (
          <p className={cn("flex items-center gap-1.5 text-[11px] font-medium", GRADE_TEXT[grade])}>
            {grade === "good" ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <AlertTriangle className="size-3.5" />
            )}
            {GRADE_LABEL[grade]}
          </p>
        ) : null}
      </div>

      {!hasStream ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleSlash className="size-3.5" /> No stream yet — packet, sample and spike rates appear
          once the headband is delivering data.
        </p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <Metric
              label="Packet dropout"
              value={num(integrity.dropoutPercent)}
              unit="%"
              recent={`${num(integrity.recent.dropoutPercent)} %`}
              hint={`${integrity.totals.droppedFrames.toLocaleString()} notifications missed across ${integrity.channels.length} electrodes`}
              alert={integrity.recent.dropoutPercent >= 5}
            />
            <Metric
              label="Unusable samples"
              value={num(integrity.nonFinitePerThousand, 2)}
              unit="per 1000"
              recent={`${num(integrity.recent.nonFinitePerThousand, 2)} per 1000`}
              hint={`${integrity.totals.nonFinite.toLocaleString()} NaN / Infinity samples received`}
              alert={integrity.recent.nonFinitePerThousand >= 10}
            />
            <Metric
              label="Spike rate"
              value={num(integrity.spikesPerMinute, 0)}
              unit="/ min"
              recent={`${num(integrity.recent.spikesPerMinute, 0)} / min`}
              hint={`${integrity.totals.spikes.toLocaleString()} samples beyond ±500 µV (movement, diathermy, knocks)`}
              alert={integrity.recent.spikesPerMinute >= 30}
            />
          </div>

          {integrity.reasons.length ? (
            <ul className="mt-2 space-y-0.5 text-[11px] text-caution">
              {integrity.reasons.map((r) => (
                <li key={r} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-[1px] size-3 shrink-0" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <table className="mt-3 w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="font-medium">Electrode</th>
                <th className="font-medium text-right">Packets</th>
                <th className="font-medium text-right">Dropped</th>
                <th className="font-medium text-right">NaN/Inf</th>
                <th className="font-medium text-right">Spikes</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {integrity.channels.map((c) => (
                <tr key={c.channel} className="border-t border-border/60">
                  <td className="py-1 font-sans">{c.channel}</td>
                  <td className="py-1 text-right">{c.frames.toLocaleString()}</td>
                  <td
                    className={cn(
                      "py-1 text-right",
                      c.droppedFrames > 0 ? "text-caution" : "text-muted-foreground",
                    )}
                  >
                    {c.droppedFrames.toLocaleString()}
                  </td>
                  <td
                    className={cn(
                      "py-1 text-right",
                      c.nonFinite > 0 ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {c.nonFinite.toLocaleString()}
                  </td>
                  <td className="py-1 text-right text-muted-foreground">
                    {c.spikes.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Suppression timer provenance ------------------------------------ */}
      <div className="mt-3 rounded-md border border-border/70 px-2.5 py-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Timer className="size-3.5" /> Suppression timer
        </p>
        {!clock || clock.elapsedSeconds <= 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            The timer starts once the first full analysis window is available.
          </p>
        ) : (
          <>
            <p className="mt-1 font-mono text-sm tabular-nums">
              {formatDuration(clock.suppressionSeconds)}
              <span className="ml-1 font-sans text-[11px] text-muted-foreground">
                counted from {formatDuration(clock.analysedSeconds)} of analysed EEG
              </span>
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-signal">
              <Activity className="size-3" />
              Counting valid analysed seconds only — {coveragePct}% of the case was analysable.
            </p>
            <p className="text-[11px] text-muted-foreground">
              Excluded: {formatDuration(clock.excludedArtifactSeconds)} artefact ·{" "}
              {formatDuration(clock.excludedGapSeconds)} data gap
              {excluded > 0
                ? ` — these ${formatDuration(excluded)} never advance the suppression clock.`
                : " — nothing excluded so far."}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
