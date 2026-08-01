import { useEffect, useRef } from "react";

import { DSA_MAX_HZ, DSA_MIN_HZ, type Epoch } from "@/lib/eeg/analysis";

const STOPS: [number, number, number][] = [
  [8, 16, 34], // floor
  [18, 62, 96],
  [16, 150, 138],
  [120, 200, 90],
  [245, 190, 40],
  [235, 80, 70],
  [255, 240, 230],
];

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
  epochs: Epoch[];
  /** Number of seconds of history to display. */
  windowSeconds: number;
  dbMin?: number;
  dbMax?: number;
}

export function DsaChart({ epochs, windowSeconds, dbMin = -6, dbMax = 26 }: Props) {
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
    ctx.fillStyle = "rgb(8,16,34)";
    ctx.fillRect(0, 0, w, h);

    const visible = epochs.slice(-windowSeconds);
    if (!visible.length) return;
    const bins = visible[visible.length - 1]!.spectrum.length;
    if (!bins) return;

    const image = ctx.createImageData(w, h);
    for (let px = 0; px < w; px++) {
      // Right-aligned: newest column at the right edge.
      const colIndex = Math.floor((px / w) * windowSeconds) - (windowSeconds - visible.length);
      const epoch = colIndex >= 0 && colIndex < visible.length ? visible[colIndex] : undefined;
      for (let py = 0; py < h; py++) {
        const idx = (py * w + px) * 4;
        if (!epoch) {
          image.data[idx] = 8;
          image.data[idx + 1] = 16;
          image.data[idx + 2] = 34;
          image.data[idx + 3] = 255;
          continue;
        }
        const bin = Math.min(bins - 1, Math.floor(((h - 1 - py) / h) * bins));
        const db = epoch.spectrum[bin] ?? dbMin;
        const [r, g, b] = colorFor(db, dbMin, dbMax);
        image.data[idx] = r;
        image.data[idx + 1] = g;
        image.data[idx + 2] = b;
        image.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);

    // Frequency gridlines every 10 Hz.
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.font = `${11 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    for (let f = 10; f < DSA_MAX_HZ; f += 10) {
      const y = h - ((f - DSA_MIN_HZ) / (DSA_MAX_HZ - DSA_MIN_HZ)) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${f} Hz`, 6 * dpr, y - 4 * dpr);
    }
  }, [epochs, windowSeconds, dbMin, dbMax]);

  return <canvas ref={canvasRef} className="h-full w-full rounded-md" aria-label="Density spectral array" />;
}

export function DsaLegend({ dbMin = -6, dbMax = 26 }: { dbMin?: number; dbMax?: number }) {
  const gradient = STOPS.map((s) => `rgb(${s[0]},${s[1]},${s[2]})`).join(",");
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="metric-value">{dbMin} dB</span>
      <div
        className="h-2 w-28 rounded-full"
        style={{ backgroundImage: `linear-gradient(to right, ${gradient})` }}
      />
      <span className="metric-value">{dbMax} dB</span>
    </div>
  );
}