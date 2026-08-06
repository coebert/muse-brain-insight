import { memo, useEffect, useMemo, useRef, useState } from "react";

import { DSA_MAX_HZ, DSA_MIN_HZ, type Epoch } from "@/lib/eeg/analysis";
import { DSA_STOPS, drawBandGutter, paintDsaHeatmap } from "@/lib/eeg/dsa-render";
import { alignSeries } from "@/lib/eeg/gaps";

/** Margins in CSS pixels. The right margin leaves room for band labels. */
const MARGIN_CSS = { top: 10, right: 60, bottom: 34, left: 48 };
/** Tightened margins for short/narrow lanes (phones, stacked bilateral view). */
const MARGIN_TIGHT = { top: 6, right: 12, bottom: 22, left: 26 };

/** Pick a margin set that keeps the plot area usable at bedside sizes. */
export function marginsFor(widthCss: number, heightCss: number) {
  const narrow = widthCss < 520;
  const short = heightCss < 190;
  return {
    top: short ? MARGIN_TIGHT.top : MARGIN_CSS.top,
    right: narrow ? MARGIN_TIGHT.right : MARGIN_CSS.right,
    bottom: short ? MARGIN_TIGHT.bottom : MARGIN_CSS.bottom,
    left: narrow ? MARGIN_TIGHT.left : MARGIN_CSS.left,
  };
}

/** A line drawn over the heat map, e.g. a per-hemisphere spectral edge. */
export interface DsaTrace {
  label: string;
  /** CSS colour for the line and legend swatch. */
  color: string;
  /** Frequency in Hz per second of history, oldest first. */
  values: number[];
}

interface Props {
  epochs?: Epoch[];
  /** Pre-computed dB spectra per second, oldest first. Overrides `epochs`. */
  frames?: number[][];
  /** Number of seconds of history to display. */
  windowSeconds: number;
  dbMin?: number;
  dbMax?: number;
  /** Optional frequency traces (Hz) drawn on top of the heat map. */
  traces?: DsaTrace[] | undefined;
  /**
   * Visible slice of the history, expressed in seconds-ago at each edge.
   * `from` is the left (older) edge, `to` the right (newer) edge.
   * Defaults to the full window (`from: windowSeconds, to: 0`).
   */
  view?: { from: number; to: number } | undefined;
}

function DsaChartInner({
  epochs,
  frames,
  windowSeconds,
  dbMin = -6,
  dbMax = 26,
  traces,
  view,
}: Props) {
  const from = view ? view.from : windowSeconds;
  const to = view ? view.to : 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Stable identity so the canvas only redraws when the data really changed.
  // Epochs are placed on a one-slot-per-second timeline so a dropout leaves a
  // real hole in the heat map instead of shifting later data left.
  const spectra = useMemo<(number[] | null)[]>(
    () =>
      frames ??
      alignSeries<Epoch, number[]>(
        epochs ?? [],
        (e) => e.t,
        (e) => e.spectrum,
      ),
    [frames, epochs],
  );

  // Re-render on resize/orientation change so the responsive margins re-apply.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

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
    const css = marginsFor(rect.width, rect.height);
    const showGutter = css.right >= 40;
    const showAxisTitles = css.left >= 40 && css.bottom >= 30;
    const margin = {
      top: css.top * dpr,
      right: css.right * dpr,
      bottom: css.bottom * dpr,
      left: css.left * dpr,
    };
    const plotW = Math.max(1, w - margin.left - margin.right);
    const plotH = Math.max(1, h - margin.top - margin.bottom);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgb(8,16,34)";
    ctx.fillRect(0, 0, w, h);

    const visible = spectra.slice(-windowSeconds);
    const bins = [...visible].reverse().find((s) => s && s.length)?.length ?? 0;
    const span = Math.max(1e-6, from - to);
    /** Seconds-ago at a given pixel column inside the plot. */
    const ageAt = (px: number) => from - (px / Math.max(1, plotW - 1)) * span;

    // Continuous heat map: interpolated in time and frequency so the display
    // reads as a smooth bedside-monitor spectrogram rather than 1 s stripes.
    if (visible.length && bins) {
      const offset = windowSeconds - visible.length;
      paintDsaHeatmap(
        ctx,
        { x: margin.left, y: margin.top, w: plotW, h: plotH },
        (px) => {
          // Right edge = `to` seconds ago, left edge = `from` seconds ago.
          const pos = windowSeconds - 1 - ageAt(px) - offset;
          const i = Math.floor(pos);
          return {
            lo: i >= 0 && i < visible.length ? (visible[i] ?? undefined) : undefined,
            hi: i + 1 >= 0 && i + 1 < visible.length ? (visible[i + 1] ?? undefined) : undefined,
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

    // Hemisphere traces (overlay comparison view).
    for (const tr of traces ?? []) {
      const vals = tr.values.slice(-windowSeconds);
      if (vals.length < 2) continue;
      const offset = windowSeconds - vals.length;
      const xFor = (i: number) => {
        const age = windowSeconds - 1 - (i + offset);
        return margin.left + ((from - age) / span) * plotW;
      };
      ctx.beginPath();
      ctx.save();
      ctx.beginPath();
      ctx.rect(margin.left, margin.top, plotW, plotH);
      ctx.clip();
      ctx.beginPath();
      vals.forEach((v, i) => {
        const x = xFor(i);
        const y = yForHz(Math.min(Math.max(v, DSA_MIN_HZ), DSA_MAX_HZ));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = tr.color;
      ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.shadowBlur = 3 * dpr;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // Band key lives in the right gutter so the heat map colours read true.
    // On narrow lanes there is no room for it, so it is dropped rather than
    // allowed to overlap the plot.
    if (showGutter) {
      drawBandGutter(ctx, {
        left: margin.left,
        plotW,
        dpr,
        yForHz,
        minHz: DSA_MIN_HZ,
        maxHz: DSA_MAX_HZ,
      });
    }

    // Frequency gridlines and y-axis labels.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    const yTicks = plotH < 110 * dpr ? [5, 15, 25] : [1, 5, 10, 15, 20, 25, 30];
    for (const f of yTicks) {
      if (f < DSA_MIN_HZ || f > DSA_MAX_HZ) continue;
      const y = yForHz(f);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${f}`, margin.left - 6 * dpr, y);
    }

    // Y-axis title (dropped on narrow lanes where it would crowd the ticks).
    if (showAxisTitles) {
      ctx.save();
      ctx.translate(12 * dpr, margin.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.font = `600 ${11 * dpr}px "Inter", system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Frequency (Hz)", 0, 0);
      ctx.restore();
    }

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

    const xTicks = plotW < 320 * dpr ? 2 : 4;
    for (let i = 0; i <= xTicks; i++) {
      const frac = i / xTicks;
      const x = margin.left + frac * plotW;
      const secondsAgo = Math.max(0, Math.round(from - frac * span));
      const label = secondsAgo === 0 ? "now" : `-${secondsAgo}s`;
      ctx.beginPath();
      ctx.moveTo(x, margin.top + plotH);
      ctx.lineTo(x, margin.top + plotH + 4 * dpr);
      ctx.stroke();
      ctx.fillText(label, x, margin.top + plotH + 7 * dpr);
    }

    // X-axis title.
    if (showAxisTitles) {
      ctx.font = `600 ${11 * dpr}px "Inter", system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText("Time →", w - margin.right + 4 * dpr, margin.top + plotH + 22 * dpr);
    }
  }, [spectra, windowSeconds, dbMin, dbMax, traces, size, from, to]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full rounded-md"
      aria-label="Density spectral array"
    />
  );
}

export const DsaChart = memo(DsaChartInner);

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
