import { useEffect, useRef } from "react";

import { DSA_MAX_HZ, DSA_MIN_HZ, type Epoch } from "@/lib/eeg/analysis";
import {
  DSA_STOPS,
  drawBandGutter,
  paintDsaHeatmap,
} from "@/lib/eeg/dsa-render";

/** Margins in CSS pixels. The right margin leaves room for band labels. */
const MARGIN_CSS = { top: 10, right: 60, bottom: 34, left: 48 };

interface Props {
  epochs?: Epoch[];
  /** Pre-computed dB spectra per second, oldest first. Overrides `epochs`. */
  frames?: number[][];
  /** Number of seconds of history to display. */
  windowSeconds: number;
  dbMin?: number;
  dbMax?: number;
}

export function DsaChart({ epochs, frames, windowSeconds, dbMin = -6, dbMax = 26 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spectra = frames ?? (epochs ?? []).map((e) => e.spectrum);

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
    const margin = {
      top: MARGIN_CSS.top * dpr,
      right: MARGIN_CSS.right * dpr,
      bottom: MARGIN_CSS.bottom * dpr,
      left: MARGIN_CSS.left * dpr,
    };
    const plotW = Math.max(1, w - margin.left - margin.right);
    const plotH = Math.max(1, h - margin.top - margin.bottom);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgb(8,16,34)";
    ctx.fillRect(0, 0, w, h);

    const visible = spectra.slice(-windowSeconds);
    const bins = visible[visible.length - 1]?.length ?? 0;

    // Continuous heat map: interpolated in time and frequency so the display
    // reads as a smooth bedside-monitor spectrogram rather than 1 s stripes.
    if (visible.length && bins) {
      const offset = windowSeconds - visible.length;
      paintDsaHeatmap(
        ctx,
        { x: margin.left, y: margin.top, w: plotW, h: plotH },
        (px) => {
          // Right-aligned: newest column at the right edge.
          const pos = (px / Math.max(1, plotW - 1)) * (windowSeconds - 1) - offset;
          const i = Math.floor(pos);
          return {
            lo: i >= 0 && i < visible.length ? visible[i]! : undefined,
            hi: i + 1 >= 0 && i + 1 < visible.length ? visible[i + 1]! : undefined,
            f: pos - i,
          };
        },
        dbMin,
        dbMax,
      );
    }

    // Plot-area border.
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);

    const yForHz = (f: number) =>
      margin.top + plotH - ((f - DSA_MIN_HZ) / (DSA_MAX_HZ - DSA_MIN_HZ)) * plotH;

    // Band key lives in the right gutter so the heat map colours read true.
    drawBandGutter(ctx, {
      left: margin.left,
      plotW,
      dpr,
      yForHz,
      minHz: DSA_MIN_HZ,
      maxHz: DSA_MAX_HZ,
    });

    // Frequency gridlines and y-axis labels.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    const yTicks = [1, 5, 10, 15, 20, 25, 30];
    for (const f of yTicks) {
      if (f < DSA_MIN_HZ || f > DSA_MAX_HZ) continue;
      const y = yForHz(f);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${f}`, margin.left - 6 * dpr, y);
    }

    // Y-axis title.
    ctx.save();
    ctx.translate(12 * dpr, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `600 ${11 * dpr}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Frequency (Hz)", 0, 0);
    ctx.restore();

    // X-axis: time. Right edge = now, left edge = -windowSeconds.
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const xTicks = 4;
    for (let i = 0; i <= xTicks; i++) {
      const frac = i / xTicks;
      const x = margin.left + frac * plotW;
      const secondsAgo = Math.round((1 - frac) * windowSeconds);
      const label = secondsAgo === 0 ? "now" : `-${secondsAgo}s`;
      ctx.beginPath();
      ctx.moveTo(x, margin.top + plotH);
      ctx.lineTo(x, margin.top + plotH + 4 * dpr);
      ctx.stroke();
      ctx.fillText(label, x, margin.top + plotH + 7 * dpr);
    }

    // X-axis title.
    ctx.font = `600 ${11 * dpr}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("Time →", w - margin.right + 4 * dpr, margin.top + plotH + 22 * dpr);
  }, [spectra, windowSeconds, dbMin, dbMax]);

  return <canvas ref={canvasRef} className="h-full w-full rounded-md" aria-label="Density spectral array" />;
}

export function DsaLegend({ dbMin = -6, dbMax = 26 }: { dbMin?: number; dbMax?: number }) {
  const gradient = DSA_STOPS.map((s) => `rgb(${s[0]},${s[1]},${s[2]})`).join(",");
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="metric-value">{dbMin} dB</span>
      <div
        className="h-2 w-28 rounded-full"
        style={{ backgroundImage: `linear-gradient(to right, ${gradient})` }}
      />
      <span className="metric-value">{dbMax} dB</span>
    </div>
  );
}