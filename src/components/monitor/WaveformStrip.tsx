import { useEffect, useRef } from "react";

interface Props {
  data: Float64Array;
  suppressionThresholdUv: number;
  suppressed: boolean;
}

export function WaveformStrip({ data, suppressionThresholdUv, suppressed }: Props) {
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
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!data.length) return;
    const scale = h / 2 / 80; // ±80 µV full scale
    ctx.lineWidth = 1.4 * dpr;
    ctx.strokeStyle = suppressed ? "rgb(245,190,40)" : "rgb(56,214,175)";
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const y = h / 2 - Math.max(-80, Math.min(80, data[i]!)) * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Suppression amplitude corridor.
    const band = (suppressionThresholdUv / 2) * scale;
    ctx.fillStyle = "rgba(245,190,40,0.12)";
    ctx.fillRect(0, h / 2 - band, w, band * 2);
  }, [data, suppressionThresholdUv, suppressed]);

  return <canvas ref={canvasRef} className="h-full w-full" aria-label="Filtered EEG waveform" />;
}