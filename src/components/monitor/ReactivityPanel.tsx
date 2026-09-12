import { useMemo } from "react";

import { formatClock } from "@/lib/eeg/format";
import {
  EVENT_LABEL,
  moaasLabel,
  type CaseObservation,
} from "@/lib/eeg/case-observations";
import {
  buildReactivity,
  describeChange,
  type ReactivityCase,
  type ReactivityEpoch,
} from "@/lib/eeg/reactivity";
import { cn } from "@/lib/utils";

function markLabel(row: CaseObservation): string {
  if (row.kind === "responsiveness") {
    return `MOAA/S ${row.moaas} · ${moaasLabel(row.moaas ?? -1)}`;
  }
  return row.eventType ? EVENT_LABEL[row.eventType] : "Event";
}

/** A small sparkline of the index across the window, with the mark in the middle. */
function WindowTrace({ row }: { row: ReactivityCase }) {
  const points = row.trace.filter((p) => p.index != null);
  if (points.length < 2) return null;
  const xs = points.map((p) => p.offset);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const span = maxX - minX || 1;
  const path = points
    .map((p, i) => {
      const x = ((p.offset - minX) / span) * 100;
      const y = 100 - Math.max(0, Math.min(100, p.index!));
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const markX = ((0 - minX) / span) * 100;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-12 w-full" aria-hidden>
      <line
        x1={markX}
        y1="0"
        x2={markX}
        y2="100"
        stroke="var(--caution)"
        strokeWidth="0.8"
        strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path}
        fill="none"
        stroke="var(--signal)"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Change({ label, change, unit }: { label: string; change: number | null; unit: string }) {
  return (
    <span className="text-xs text-muted-foreground">
      {label}:{" "}
      <span
        className={cn(
          "metric-value",
          change == null
            ? "text-muted-foreground"
            : Math.abs(change) < 1
              ? "text-foreground"
              : "text-signal",
        )}
      >
        {describeChange(change, unit)}
      </span>
    </span>
  );
}

/**
 * What the EEG did around each marked moment. This is the only place the index
 * is checked against something observed rather than against another monitor,
 * so it reports the readings each side and stays quiet when there are too few.
 */
export function ReactivityPanel({
  observations,
  epochs,
  windowSeconds = 60,
}: {
  observations: CaseObservation[];
  epochs: ReactivityEpoch[];
  windowSeconds?: number;
}) {
  const rows = useMemo(
    () => buildReactivity(observations, epochs, { seconds: windowSeconds }),
    [observations, epochs, windowSeconds],
  );

  return (
    <section className="rounded-lg border border-border bg-card/60">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Reactivity</h2>
        <p className="text-xs text-muted-foreground">
          The trace {windowSeconds} s either side of each marked moment
        </p>
      </header>

      {!rows.length ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          Nothing to show yet. Record a responsiveness score or mark a stimulus and the EEG around
          it appears here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows
            .slice()
            .reverse()
            .map((row) => {
              const thin = row.beforeCount < 3 || row.afterCount < 3;
              return (
                <li key={row.observation.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="metric-value text-xs text-muted-foreground">
                      {formatClock(row.observation.atSeconds)}
                    </span>
                    <span className="text-xs font-medium">{markLabel(row.observation)}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {row.beforeCount} before · {row.afterCount} after
                    </span>
                  </div>
                  <WindowTrace row={row} />
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <Change label="Depth index" change={row.depth.change} unit="points" />
                    <Change label="SEF95" change={row.sef95.change} unit="Hz" />
                    <Change label="Suppression" change={row.suppression.change} unit="%" />
                  </div>
                  {thin ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Too few readings either side to read anything into this change.
                    </p>
                  ) : null}
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}
