import { memo, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface DsaMarker {
  /** Seconds since session start. */
  t: number;
  label: string;
  tone: "marker" | "caution" | "critical";
  /** Label at the top of the lane rather than the bottom. */
  top?: boolean;
}

const line: Record<DsaMarker["tone"], string> = {
  marker: "bg-marker/80",
  caution: "bg-caution/80",
  critical: "bg-critical/80",
};

const chip: Record<DsaMarker["tone"], string> = {
  marker: "bg-marker/25 text-marker ring-marker/40",
  caution: "bg-caution/25 text-caution ring-caution/40",
  critical: "bg-critical/25 text-critical ring-critical/40",
};

/** Row geometry — fixed pixel sizes so labels never scale with the lane. */
const ROW_H = 17;
const TOP_OFFSET = 22;
const BOTTOM_OFFSET = 22;
const GAP_PX = 6;
const CHAR_PX = 5.6;
const PAD_PX = 10;
const MAX_LABEL_PX = 132;
const MIN_LABEL_PX = 34;

interface Placed {
  m: DsaMarker;
  key: string;
  x: number;
  row: number;
  width: number;
  /** Render the chip to the left of the tick (near the right edge). */
  flip: boolean;
  hidden: boolean;
}

function estimateWidth(label: string): number {
  return Math.min(MAX_LABEL_PX, Math.max(MIN_LABEL_PX, label.length * CHAR_PX + PAD_PX));
}

/**
 * Greedy row packing: each label takes the first row where it does not collide
 * with a label already placed there. Rows are capped so the chips can never
 * cover the spectrogram; overflow markers keep their tick but drop the chip.
 */
function layout(markers: DsaMarker[], elapsed: number, windowSeconds: number, width: number, maxRows: number) {
  const rowsTop: number[][] = [];
  const rowsBottom: number[][] = [];
  const out: Placed[] = [];

  const visible = markers
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => {
      const age = elapsed - m.t;
      return age >= 0 && age <= windowSeconds;
    })
    .sort((a, b) => a.m.t - b.m.t);

  for (const { m, i } of visible) {
    const age = elapsed - m.t;
    const x = (1 - age / windowSeconds) * width;
    const w = estimateWidth(m.label);
    const flip = x + w + 4 > width;
    const start = flip ? x - w - 2 : x + 2;
    const end = start + w;

    const rows = m.top ? rowsTop : rowsBottom;
    let row = -1;
    for (let r = 0; r < maxRows; r++) {
      const occupied = rows[r] ?? [];
      const clash = occupied.some(([s, e]) => start < e + GAP_PX && end + GAP_PX > s);
      if (!clash) {
        row = r;
        rows[r] = [...occupied, [start, end] as unknown as number[]] as number[][] as never;
        break;
      }
    }
    out.push({
      m,
      key: `${m.tone}-${m.t}-${i}`,
      x,
      row: row < 0 ? 0 : row,
      width: w,
      flip,
      hidden: row < 0,
    });
  }
  return out;
}

/**
 * Vertical time markers drawn over a DSA lane. Shared by the dashboard and the
 * fullscreen monitor so marker placement maths lives in one place.
 */
function DsaMarkerRailInner({
  markers,
  elapsed,
  windowSeconds,
}: {
  markers: DsaMarker[];
  elapsed: number;
  windowSeconds: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxRows = Math.max(
    1,
    Math.min(4, Math.floor((size.height - TOP_OFFSET - BOTTOM_OFFSET) / 2 / ROW_H) || 1),
  );

  const placed = useMemo(
    () =>
      size.width > 0 ? layout(markers, elapsed, windowSeconds, size.width, maxRows) : ([] as Placed[]),
    [markers, elapsed, windowSeconds, size.width, maxRows],
  );

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {placed.map((p) => (
        <div key={p.key} className="absolute top-0 bottom-0" style={{ left: `${p.x}px` }}>
          <div className={cn("h-full w-px", line[p.m.tone])} />
          {p.hidden ? null : (
            <span
              className={cn(
                "metric-value absolute overflow-hidden rounded px-1 leading-[15px] text-ellipsis whitespace-nowrap ring-1 backdrop-blur-[2px]",
                chip[p.m.tone],
              )}
              style={{
                fontSize: 10,
                height: 15,
                width: p.width,
                [p.flip ? "right" : "left"]: 2,
                [p.m.top ? "top" : "bottom"]:
                  (p.m.top ? TOP_OFFSET : BOTTOM_OFFSET) + p.row * ROW_H,
              }}
              title={p.m.label}
            >
              {p.m.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export const DsaMarkerRail = memo(DsaMarkerRailInner);
