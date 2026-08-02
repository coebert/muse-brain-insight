import { useEffect, useRef } from "react";

import { DSA_MAX_HZ, DSA_MIN_HZ } from "@/lib/eeg/analysis";
import { formatClock } from "@/lib/eeg/format";

const STOPS: [number, number, number][] = [
  [8, 16, 34],
  [18, 62, 96],
  [16, 150, 138],
  [120, 200, 90],
  [245, 190, 40],
  [235, 80, 70],
  [255, 240, 230],
];

const BANDS: { label: string; lo: number; hi: number; color: string }[] = [
  { label: "Delta", lo: 0.5, hi: 4, color: "rgba(99,102,241,0.30)" },
  { label: "Theta", lo: 4, hi: 8, color: "rgba(34,211,238,0.26)" },
  { label: "Alpha", lo: 8, hi: 13, color: "rgba(52,211,153,0.26)" },
  { label: "Beta", lo: 13, hi: 30, color: "rgba(250,204,21,0.26)" },
];

const MARGIN_CSS = { top: 10, right: 54, bottom: 36, left: 48 };

function colorFor(db: number, min: number, max: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, (db - min) / (max - min)));
  const scaled = x * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

interface Props {
  /** Spectra in time order; each is a dB array spanning DSA_MIN_HZ..DSA_MAX_HZ. */
  spectra: number[][];
  /** Epoch time offsets (seconds) matching `spectra`. */
  times: number[];
  dbMin?: number;
  dbMax?: number;
}

/** Whole-session density spectral array: the full recording compressed to one canvas. */
export function SessionDsa({ spectra, times, dbMin = -6, dbMax = 26 }: Props) {
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
      const image = ctx.createImageData(plotW, plotH);
      for (let px = 0; px < plotW; px++) {
        // Map pixel column to session time, then to the nearest stored epoch.
        const t = tStart + (px / Math.max(1, plotW - 1)) * span;
        let lo = 0;
        let hi = times.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((times[mid] ?? 0) < t) lo = mid + 1;
          else hi = mid;
        }
        let idxEpoch = lo;
        if (lo > 0 && Math.abs((times[lo] ?? 0) - t) > Math.abs(t - (times[lo - 1] ?? 0))) {
          idxEpoch = lo - 1;
        }
        const spectrum = spectra[idxEpoch];
        for (let py = 0; py < plotH; py++) {
          const idx = (py * plotW + px) * 4;
          if (!spectrum || !spectrum.length) {
            image.data[idx] = 8;
            image.data[idx + 1] = 16;
            image.data[idx + 2] = 34;
            image.data[idx + 3] = 255;
            continue;
          }
          const bin = Math.min(
            spectrum.length - 1,
            Math.floor(((plotH - 1 - py) / plotH) * spectrum.length),
          );
          const [r, g, b] = colorFor(spectrum[bin] ?? dbMin, dbMin, dbMax);
          image.data[idx] = r;
          image.data[idx + 1] = g;
          image.data[idx + 2] = b;
          image.data[idx + 3] = 255;
        }
      }
      ctx.putImageData(image, margin.left, margin.top);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);

    const yForHz = (f: number) =>
      margin.top + plotH - ((f - DSA_MIN_HZ) / (DSA_MAX_HZ - DSA_MIN_HZ)) * plotH;

    for (const band of BANDS) {
      const yLo = yForHz(band.lo);
      const yHi = yForHz(band.hi);
      ctx.fillStyle = band.color;
      ctx.fillRect(margin.left, yHi, plotW, yLo - yHi);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(margin.left, yHi);
      ctx.lineTo(margin.left + plotW, yHi);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `600 ${10 * dpr}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(band.label, margin.left + plotW + 7 * dpr, (yHi + yLo) / 2);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
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
  }, [spectra, times, dbMin, dbMax]);

  return (
    <canvas ref={canvasRef} className="h-full w-full rounded-md" aria-label="Whole-session density spectral array" />
  );
}
