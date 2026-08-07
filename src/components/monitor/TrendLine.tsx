import { memo, useCallback, useEffect, useRef, useState } from "react";

import { nullRuns } from "@/lib/eeg/gaps";

interface Props {
  /** Values in plot order (oldest first). Null gaps are skipped. */
  values: (number | null)[];
  min: number;
  max: number;
  color: string;
  /** Optional horizontal target band, in value units. */
  band?: [number, number];
  height?: number;
  /** Skip the opaque backdrop when layering a second trend on top. */
  transparent?: boolean;
  /** Short unit shown in the tap-to-inspect readout, e.g. "Hz" or "%". */
  unit?: string;
  /** Decimal places used by the tap-to-inspect readout. */
  precision?: number;
  /** Disable the tap/hover readout (for layered overlay traces). */
  inspectable?: boolean;
}

/** Compact canvas trend line used by the fullscreen monitor. */
function TrendLineInner({
  values,
  min,
  max,
  color,
  band,
  height = 90,
  transparent = false,
  unit,
  precision = 0,
  inspectable = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [probe, setProbe] = useState<{ x: number; value: number | null } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    if (!transparent) {
      ctx.fillStyle = "rgb(8,16,34)";
      ctx.fillRect(0, 0, w, h);
    }

    const y = (v: number) => h - ((v - min) / (max - min)) * h;

    if (band) {
      ctx.fillStyle = "rgba(56,214,175,0.10)";
      const top = y(band[1]);
      ctx.fillRect(0, top, w, y(band[0]) - top);
    }

    if (!transparent) ctx.strokeStyle = "rgba(255,255,255,0.08)";
    else ctx.strokeStyle = "rgba(0,0,0,0)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gy = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    if (values.length < 2) return;
    // Shade stretches with no data so a break in the line reads as missing
    // EEG rather than a flat or absent trend.
    if (!transparent) {
      const slotW = w / Math.max(1, values.length - 1);
      ctx.fillStyle = "rgba(148,163,184,0.16)";
      for (const [start, end] of nullRuns(values)) {
        const x0 = start * slotW;
        const x1 = Math.min(w, (end + 1) * slotW);
        if (x1 - x0 > 0.5) ctx.fillRect(x0, 0, x1 - x0, h);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let drawing = false;
    values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) {
        drawing = false;
        return;
      }
      const x = (i / (values.length - 1)) * w;
      const py = y(Math.max(min, Math.min(max, v)));
      if (!drawing) {
        ctx.moveTo(x, py);
        drawing = true;
      } else {
        ctx.lineTo(x, py);
      }
    });
    ctx.stroke();
  }, [values, min, max, color, band, transparent]);

  const inspect = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas || values.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
      const index = Math.round(ratio * (values.length - 1));
      const value = values[index];
      setProbe({
        x: ratio * rect.width,
        value: value == null || !Number.isFinite(value) ? null : value,
      });
    },
    [values],
  );

  return (
    <div className="relative" style={{ height }}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        style={{ height }}
        onPointerDown={inspectable ? (e) => inspect(e.clientX) : undefined}
        onPointerMove={
          inspectable
            ? (e) => {
                if (e.pointerType === "mouse" || e.buttons > 0) inspect(e.clientX);
              }
            : undefined
        }
        onPointerLeave={inspectable ? () => setProbe(null) : undefined}
        onPointerUp={inspectable ? () => setProbe(null) : undefined}
      />
      {inspectable && probe ? (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
            style={{ left: probe.x }}
          />
          <div
            className="pointer-events-none absolute top-1 -translate-x-1/2 rounded border border-border bg-background/95 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-foreground"
            style={{
              left: `clamp(1.75rem, ${probe.x}px, calc(100% - 1.75rem))`,
            }}
          >
            {probe.value == null ? "no data" : `${probe.value.toFixed(precision)}${unit ? ` ${unit}` : ""}`}
          </div>
        </>
      ) : null}
    </div>
  );
}

export const TrendLine = memo(TrendLineInner);
