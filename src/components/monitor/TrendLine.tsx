import { memo, useEffect, useRef } from "react";

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
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

  return <canvas ref={canvasRef} className="block h-full w-full" style={{ height }} />;
}

export const TrendLine = memo(TrendLineInner);
