import { useEffect, useRef, useState } from "react";

import { marginsFor } from "@/components/monitor/DsaChart";
import {
  TCI_DRUG_COLORS,
  ceHistory,
  formatCe,
  tciModel,
  type TciDrugKey,
  type TciInfusion,
} from "@/lib/eeg/tci";
import { formatClock } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

interface Row {
  key: string;
  label: string;
  color: string;
  unit: string;
  /** Step points in case-clock seconds, oldest first. */
  points: { at: number; value: number }[];
  max: number;
  from: number;
  to: number;
}

/**
 * A dosing lane drawn on the same time axis as the DSA: one row per drug of
 * each TCI pump, with a stepped Ce trace and a dot at every target change, so
 * boluses and target adjustments can be read straight against EEG events.
 */
export function TciTimeline({
  infusions,
  elapsed,
  windowSeconds,
  view,
  compact = false,
}: {
  infusions: TciInfusion[];
  elapsed: number;
  windowSeconds: number;
  view?: { from: number; to: number };
  compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const from = view ? view.from : windowSeconds; // seconds ago at left edge
  const to = view ? view.to : 0;
  const span = Math.max(1, from - to);
  const tStart = elapsed - from;
  const tEnd = elapsed - to;

  const rows: Row[] = [];
  for (const inf of infusions) {
    const model = tciModel(inf.modelKey);
    if (!model) continue;
    const stop = inf.stoppedAt ?? elapsed;
    if (stop < tStart || inf.startedAt > tEnd) continue;
    for (const drug of model.drugs) {
      rows.push({
        key: `${inf.id}-${drug.key}`,
        label: `${model.short} · ${drug.label}`,
        color: TCI_DRUG_COLORS[drug.key as TciDrugKey] ?? "rgb(160,160,160)",
        unit: drug.unit,
        points: ceHistory(inf, drug.key),
        max: drug.max,
        from: inf.startedAt,
        to: stop,
      });
    }
  }

  const m = marginsFor(width, 400);
  const plotW = Math.max(1, width - m.left - m.right);
  const x = (t: number) => m.left + ((t - tStart) / span) * plotW;
  const rowH = compact ? 18 : 24;

  if (rows.length === 0) return null;

  return (
    <div
      ref={ref}
      className="shrink-0 border-t border-border/60 bg-card/40"
      aria-label="TCI dosing timeline"
    >
      <div className="metric-value px-2 pt-1 text-[0.65rem] tracking-[0.12em] text-muted-foreground uppercase">
        TCI dosing
      </div>
      <svg
        width="100%"
        height={rows.length * rowH + 4}
        viewBox={`0 0 ${Math.max(1, width)} ${rows.length * rowH + 4}`}
        preserveAspectRatio="none"
        role="img"
      >
        {rows.map((row, i) => {
          const y0 = i * rowH + 2;
          const top = y0 + (compact ? 3 : 4);
          const bottom = y0 + rowH - (compact ? 3 : 4);
          const h = Math.max(1, bottom - top);
          const yFor = (v: number) => bottom - Math.min(1, v / row.max) * h;
          const segs: { x1: number; x2: number; y: number; value: number; at: number }[] = [];
          row.points.forEach((p, idx) => {
            const next = row.points[idx + 1];
            const segStart = Math.max(p.at, row.from);
            const segEnd = Math.min(next ? next.at : row.to, row.to);
            if (segEnd <= tStart || segStart >= tEnd) return;
            segs.push({
              x1: x(Math.max(segStart, tStart)),
              x2: x(Math.min(segEnd, tEnd)),
              y: yFor(p.value),
              value: p.value,
              at: p.at,
            });
          });
          return (
            <g key={row.key}>
              <rect
                x={m.left}
                y={y0}
                width={plotW}
                height={rowH - 2}
                fill="currentColor"
                className="text-muted/20"
              />
              {segs.map((s, si) => (
                <g key={si}>
                  <line
                    x1={s.x1}
                    x2={s.x2}
                    y1={s.y}
                    y2={s.y}
                    stroke={row.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  {si > 0 ? (
                    <line
                      x1={s.x1}
                      x2={s.x1}
                      y1={segs[si - 1]!.y}
                      y2={s.y}
                      stroke={row.color}
                      strokeWidth={1.5}
                      opacity={0.8}
                    />
                  ) : null}
                  {s.at >= tStart && s.at <= tEnd ? (
                    <circle cx={x(s.at)} cy={s.y} r={compact ? 2 : 2.5} fill={row.color}>
                      <title>{`${row.label} — ${s.value} ${row.unit} at ${formatClock(s.at)}`}</title>
                    </circle>
                  ) : null}
                </g>
              ))}
              <text
                x={2}
                y={y0 + rowH / 2 + 3}
                className={cn("fill-muted-foreground", compact ? "text-[8px]" : "text-[11px]")}
                style={{ fontSize: compact ? 8 : 9 }}
              >
                {row.label.slice(0, compact ? 10 : 16)}
              </text>
              {segs.length ? (
                <text
                  x={Math.min(width - 2, segs[segs.length - 1]!.x2 + 3)}
                  y={segs[segs.length - 1]!.y - 3}
                  textAnchor="end"
                  fill={row.color}
                  style={{ fontSize: compact ? 8 : 9 }}
                >
                  {formatCe(segs[segs.length - 1]!.value, {
                    key: "propofol",
                    label: "",
                    unit: row.unit,
                    step: row.max > 20 ? 1 : 0.1,
                    max: row.max,
                    typical: 0,
                  })}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
