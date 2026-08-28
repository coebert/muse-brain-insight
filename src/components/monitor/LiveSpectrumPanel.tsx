import { useMemo, useState } from "react";
import { Activity, CircleSlash } from "lucide-react";

import { DSA_MAX_HZ, DSA_MIN_HZ, type Epoch } from "@/lib/eeg/analysis";
import { DSA_BANDS } from "@/lib/eeg/dsa-render";
import { cn } from "@/lib/utils";

export interface LiveSpectrumPanelProps {
  /** Most recent analysed epoch; its spectrum drives the chart. */
  latest: Epoch | null | undefined;
  /** Recent epochs, used for a faint trailing-average reference curve. */
  epochs?: Epoch[];
  className?: string;
}

const VIEW_W = 600;
const VIEW_H = 200;
const PAD = { top: 10, right: 10, bottom: 24, left: 34 };

/** Frequency (Hz) at a spectrum bin index, assuming bins span the DSA range. */
function hzAt(i: number, n: number) {
  if (n <= 1) return DSA_MIN_HZ;
  return DSA_MIN_HZ + (i / (n - 1)) * (DSA_MAX_HZ - DSA_MIN_HZ);
}

const BAND_AT = (hz: number) => DSA_BANDS.find((b) => hz >= b.lo && hz < b.hi)?.label ?? "—";

/**
 * Live spectral read-out for the Signal tab: the current epoch's power
 * spectrum as an interactive chart, with per-bin hover tooltips showing the
 * frequency, its band and the power in dB.
 */
export function LiveSpectrumPanel({ latest, epochs = [], className }: LiveSpectrumPanelProps) {
  const [hover, setHover] = useState<number | null>(null);

  const spectrum = latest?.spectrum ?? [];
  const n = spectrum.length;

  // Trailing mean over the last 10 epochs as a reference curve.
  const mean = useMemo(() => {
    const recent = epochs.slice(-10).filter((e) => e.spectrum.length === n);
    if (recent.length < 2 || !n) return null;
    const out = new Array<number>(n).fill(0);
    for (const e of recent) for (let i = 0; i < n; i++) out[i]! += e.spectrum[i]! / recent.length;
    return out;
  }, [epochs, n]);

  const { min, max } = useMemo(() => {
    if (!n) return { min: -10, max: 30 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of spectrum) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: -10, max: 30 };
    const pad = Math.max(2, (hi - lo) * 0.12);
    return { min: lo - pad, max: hi + pad };
  }, [spectrum, n]);

  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;
  const xFor = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const xForHz = (hz: number) =>
    PAD.left + ((hz - DSA_MIN_HZ) / (DSA_MAX_HZ - DSA_MIN_HZ)) * plotW;
  const yFor = (db: number) =>
    PAD.top + plotH - ((Math.min(max, Math.max(min, db)) - min) / Math.max(1e-6, max - min)) * plotH;

  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(" ");

  const area = n ? `${path(spectrum)} L${xFor(n - 1).toFixed(1)},${PAD.top + plotH} L${xFor(0).toFixed(1)},${PAD.top + plotH} Z` : "";

  const yTicks = useMemo(() => {
    const step = (max - min) / 3;
    return [0, 1, 2, 3].map((k) => min + k * step);
  }, [min, max]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!n) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const frac = (x - PAD.left) / plotW;
    const i = Math.round(Math.min(1, Math.max(0, frac)) * (n - 1));
    setHover(i);
  };

  const hoverHz = hover != null ? hzAt(hover, n) : 0;
  const hoverDb = hover != null ? spectrum[hover] : undefined;
  const tipLeftPct =
    hover != null ? Math.min(82, Math.max(2, ((xFor(hover) - PAD.left) / plotW) * 100)) : 0;

  return (
    <section
      className={cn("panel border border-border px-3 py-3", className)}
      aria-label="Live spectral bands"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Spectrum (live)
        </h3>
        {n ? (
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-signal">
            <Activity className="size-3.5" /> streaming · {n} bins
          </p>
        ) : null}
      </div>

      {!n ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CircleSlash className="size-3.5" /> No spectrum yet — the chart fills in as soon as
          notifications are streaming and the first epoch is analysed.
        </p>
      ) : (
        <>
          <div className="relative">
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              className="h-48 w-full touch-none select-none"
              role="img"
              aria-label="Live power spectrum with per-bin hover read-out"
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={() => setHover(null)}
            >
              {/* Band shading */}
              {DSA_BANDS.map((b) => {
                const x0 = xForHz(Math.max(DSA_MIN_HZ, b.lo));
                const x1 = xForHz(Math.min(DSA_MAX_HZ, b.hi));
                if (x1 <= x0) return null;
                return (
                  <g key={b.label}>
                    <rect
                      x={x0}
                      y={PAD.top}
                      width={x1 - x0}
                      height={plotH}
                      fill={b.color}
                      opacity={0.07}
                    />
                    <line
                      x1={x1}
                      x2={x1}
                      y1={PAD.top}
                      y2={PAD.top + plotH}
                      stroke="currentColor"
                      className="text-border"
                      strokeDasharray="2 3"
                    />
                    <text
                      x={(x0 + x1) / 2}
                      y={PAD.top + 10}
                      textAnchor="middle"
                      fontSize="9"
                      fill={b.color}
                    >
                      {b.label}
                    </text>
                  </g>
                );
              })}

              {/* Y gridlines + labels */}
              {yTicks.map((v) => (
                <g key={v}>
                  <line
                    x1={PAD.left}
                    x2={PAD.left + plotW}
                    y1={yFor(v)}
                    y2={yFor(v)}
                    stroke="currentColor"
                    className="text-border/60"
                  />
                  <text
                    x={PAD.left - 5}
                    y={yFor(v) + 3}
                    textAnchor="end"
                    fontSize="9"
                    className="fill-muted-foreground"
                  >
                    {v.toFixed(0)}
                  </text>
                </g>
              ))}

              {/* Trailing mean */}
              {mean ? (
                <path
                  d={path(mean)}
                  fill="none"
                  stroke="currentColor"
                  className="text-muted-foreground/50"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              ) : null}

              {/* Current spectrum */}
              <path d={area} className="fill-signal/15" />
              <path
                d={path(spectrum)}
                fill="none"
                stroke="currentColor"
                className="text-signal"
                strokeWidth={1.8}
                strokeLinejoin="round"
              />

              {/* Hover cursor */}
              {hover != null && hoverDb != null ? (
                <g>
                  <line
                    x1={xFor(hover)}
                    x2={xFor(hover)}
                    y1={PAD.top}
                    y2={PAD.top + plotH}
                    stroke="currentColor"
                    className="text-foreground/50"
                  />
                  <circle cx={xFor(hover)} cy={yFor(hoverDb)} r={3} className="fill-signal" />
                </g>
              ) : null}

              {/* X axis */}
              <line
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={PAD.top + plotH}
                y2={PAD.top + plotH}
                stroke="currentColor"
                className="text-border"
              />
              {[1, 5, 10, 15, 20, 25, 30].map((hz) => (
                <text
                  key={hz}
                  x={xForHz(hz)}
                  y={VIEW_H - 8}
                  textAnchor="middle"
                  fontSize="9"
                  className="fill-muted-foreground"
                >
                  {hz}
                </text>
              ))}
              <text
                x={PAD.left + plotW}
                y={VIEW_H - 8}
                textAnchor="end"
                fontSize="9"
                className="fill-muted-foreground"
                opacity={0}
              >
                Hz
              </text>
            </svg>

            {hover != null && hoverDb != null ? (
              <div
                className="pointer-events-none absolute top-2 rounded-md border border-border bg-popover/95 px-2 py-1 text-[11px] shadow-md"
                style={{ left: `${tipLeftPct}%` }}
              >
                <p className="font-mono tabular-nums text-foreground">
                  {hoverHz.toFixed(2)} Hz · {hoverDb.toFixed(1)} dB
                </p>
                <p className="text-muted-foreground">
                  {BAND_AT(hoverHz)} band · bin {hover + 1}/{n}
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {(
              [
                ["Delta", latest?.bands.delta],
                ["Theta", latest?.bands.theta],
                ["Alpha", latest?.bands.alpha],
                ["Beta", latest?.bands.beta],
                ["Gamma", latest?.bands.gamma],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="rounded-md border border-border/70 px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="font-mono text-sm tabular-nums text-foreground">
                  {v != null && Number.isFinite(v) ? v.toFixed(1) : "–"}
                  <span className="ml-1 font-sans text-[10px] text-muted-foreground">µV²</span>
                </p>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Hover or drag across the trace for the frequency and power at each bin. The dashed line
            is the mean of the last 10 s.
          </p>
        </>
      )}
    </section>
  );
}
