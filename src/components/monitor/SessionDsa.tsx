import { useCallback, useEffect, useRef } from "react";

import { DSA_MAX_HZ, DSA_MIN_HZ } from "@/lib/eeg/analysis";
import { drawBandGutter, paintDsaHeatmap } from "@/lib/eeg/dsa-render";
import { spansGap } from "@/lib/eeg/gaps";
import { formatClock } from "@/lib/eeg/format";

const MARGIN_CSS = { top: 10, right: 60, bottom: 36, left: 48 };

interface Props {
  /** Spectra in time order; each is a dB array spanning DSA_MIN_HZ..DSA_MAX_HZ. */
  spectra: number[][];
  /** Epoch time offsets (seconds) matching `spectra`. */
  times: number[];
  dbMin?: number;
  dbMax?: number;
  /** Highlighted review window (session-relative seconds). */
  highlight?: { start: number; end: number } | null;
  /** Scrubber cursor position in session-relative seconds. */
  cursor?: number | null;
  /** Called with a session-relative time when the plot area is clicked or dragged. */
  onSeek?: (t: number) => void;
}

/** Whole-session density spectral array: the full recording compressed to one canvas. */
export function SessionDsa({
  spectra,
  times,
  dbMin = -6,
  dbMax = 26,
  highlight = null,
  cursor = null,
  onSeek,
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

    const bins = spectra.find((s) => s.length)?.length ?? 0;
    const tStart = times[0] ?? 0;
    const tEnd = times[times.length - 1] ?? tStart + 1;
    const span = Math.max(1, tEnd - tStart);

    if (spectra.length && bins) {
      paintDsaHeatmap(
        ctx,
        { x: margin.left, y: margin.top, w: plotW, h: plotH },
        (px) => {
          // Map pixel column to session time, then blend the bracketing epochs.
          const t = tStart + (px / Math.max(1, plotW - 1)) * span;
          let lo = 0;
          let hi = times.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if ((times[mid] ?? 0) < t) lo = mid + 1;
            else hi = mid;
          }
          const after = lo;
          const before = Math.max(0, lo - 1);
          const tA = times[before] ?? t;
          const tB = times[after] ?? tA;
          const f = tB > tA ? Math.max(0, Math.min(1, (t - tA) / (tB - tA))) : 0;
          const loSpec = spectra[before];
          const hiSpec = spectra[after];
          // Never blend across missing EEG: a dropout is painted as backdrop
          // rather than a smooth ramp between the epochs either side of it.
          if (after !== before && spansGap(tA, tB)) {
            return { lo: undefined, hi: undefined, f: 0 };
          }
          return {
            lo: loSpec && loSpec.length ? loSpec : undefined,
            hi: hiSpec && hiSpec.length ? hiSpec : undefined,
            f,
          };
        },
        dbMin,
        dbMax,
      );
    }

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);

    const yForHz = (f: number) =>
      margin.top + plotH - ((f - DSA_MIN_HZ) / (DSA_MAX_HZ - DSA_MIN_HZ)) * plotH;

    drawBandGutter(ctx, {
      left: margin.left,
      plotW,
      dpr,
      yForHz,
      minHz: DSA_MIN_HZ,
      maxHz: DSA_MAX_HZ,
      fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
    });

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const f of [1, 5, 10, 15, 20, 25, 30]) {
      if (f < DSA_MIN_HZ || f > DSA_MAX_HZ) continue;
      const y = yForHz(f);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${f}`, margin.left - 6 * dpr, y);
    }

    ctx.save();
    ctx.translate(12 * dpr, margin.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `600 ${11 * dpr}px "IBM Plex Sans", system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Frequency (Hz)", 0, 0);
    ctx.restore();

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    ctx.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
      const frac = i / xTicks;
      const x = margin.left + frac * plotW;
      ctx.beginPath();
      ctx.moveTo(x, margin.top + plotH);
      ctx.lineTo(x, margin.top + plotH + 4 * dpr);
      ctx.stroke();
      ctx.fillText(formatClock(tStart + frac * span), x, margin.top + plotH + 7 * dpr);
    }

    ctx.font = `600 ${11 * dpr}px "IBM Plex Sans", system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("Elapsed time →", w - margin.right + 4 * dpr, margin.top + plotH + 22 * dpr);

    const xForTime = (t: number) =>
      margin.left + ((Math.max(tStart, Math.min(tEnd, t)) - tStart) / span) * plotW;

    // Selected alert window overlay.
    if (highlight) {
      const x0 = xForTime(Math.min(highlight.start, highlight.end));
      const x1 = xForTime(Math.max(highlight.start, highlight.end));
      ctx.save();
      ctx.beginPath();
      ctx.rect(margin.left, margin.top, plotW, plotH);
      ctx.clip();
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.fillRect(x0, margin.top, Math.max(2 * dpr, x1 - x0), plotH);
      ctx.strokeStyle = "rgba(255,255,255,0.65)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.strokeRect(x0, margin.top, Math.max(2 * dpr, x1 - x0), plotH);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Scrubber cursor.
    if (cursor != null) {
      const x = xForTime(cursor);
      ctx.strokeStyle = "rgb(56,214,175)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + plotH);
      ctx.stroke();
      ctx.fillStyle = "rgb(56,214,175)";
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x - 4 * dpr, margin.top - 6 * dpr);
      ctx.lineTo(x + 4 * dpr, margin.top - 6 * dpr);
      ctx.closePath();
      ctx.fill();
    }
  }, [spectra, times, dbMin, dbMax, highlight, cursor]);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !onSeek) return;
      const rect = canvas.getBoundingClientRect();
      const plotLeft = rect.left + MARGIN_CSS.left;
      const plotW = Math.max(1, rect.width - MARGIN_CSS.left - MARGIN_CSS.right);
      const frac = Math.max(0, Math.min(1, (clientX - plotLeft) / plotW));
      const tStart = times[0] ?? 0;
      const tEnd = times[times.length - 1] ?? tStart + 1;
      onSeek(tStart + frac * Math.max(1, tEnd - tStart));
    },
    [onSeek, times],
  );

  return (
    <canvas
      ref={canvasRef}
      className={`h-full w-full rounded-md ${onSeek ? "cursor-crosshair" : ""}`}
      aria-label="Whole-session density spectral array"
      onPointerDown={(e) => {
        if (!onSeek) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromEvent(e.clientX);
      }}
      onPointerMove={(e) => {
        if (!onSeek || e.buttons !== 1) return;
        seekFromEvent(e.clientX);
      }}
    />
  );
}
