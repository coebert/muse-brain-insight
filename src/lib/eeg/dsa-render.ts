/**
 * Shared rendering helpers for the density spectral array (DSA) heat map.
 *
 * The palette and sampling here are tuned to look like a bedside depth-of-
 * anaesthesia monitor: a continuous "jet"-style heat map with no visible
 * epoch banding, drawn edge to edge inside the plot area.
 */

export type Rgb = [number, number, number];

/** BIS-style spectrogram palette: deep blue -> cyan -> green -> yellow -> red -> white. */
export const DSA_STOPS: Rgb[] = [
  [6, 10, 40],
  [14, 40, 120],
  [10, 110, 190],
  [12, 175, 175],
  [70, 200, 90],
  [190, 215, 45],
  [250, 190, 30],
  [240, 110, 40],
  [220, 45, 55],
  [255, 235, 225],
];

/** Frequency bands annotated alongside the heat map. */
export const DSA_BANDS: { label: string; lo: number; hi: number; color: string }[] = [
  { label: "Delta", lo: 0.5, hi: 4, color: "rgb(129,140,248)" },
  { label: "Theta", lo: 4, hi: 8, color: "rgb(34,211,238)" },
  { label: "Alpha", lo: 8, hi: 13, color: "rgb(52,211,153)" },
  { label: "Beta", lo: 13, hi: 30, color: "rgb(250,204,21)" },
];

/** Background colour used for regions with no data. */
export const DSA_BACKDROP: Rgb = [6, 10, 24];

export function dsaColor(db: number, min: number, max: number): Rgb {
  const x = Math.max(0, Math.min(1, (db - min) / (max - min)));
  const scaled = x * (DSA_STOPS.length - 1);
  const i = Math.min(DSA_STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = DSA_STOPS[i]!;
  const b = DSA_STOPS[i + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** Linear interpolation inside one spectrum, `frac` = 0 at the lowest bin. */
function sampleSpectrum(spectrum: number[] | undefined, frac: number): number | null {
  if (!spectrum || spectrum.length === 0) return null;
  const pos = Math.max(0, Math.min(1, frac)) * (spectrum.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = spectrum[i];
  const b = spectrum[Math.min(spectrum.length - 1, i + 1)] ?? a;
  if (a == null || b == null) return null;
  return a + (b - a) * f;
}

export interface ColumnSample {
  /** Spectrum at or before this pixel column. */
  lo?: number[];
  /** Spectrum after this pixel column (used for smooth time interpolation). */
  hi?: number[];
  /** Blend factor between `lo` and `hi` (0..1). */
  f: number;
}

/**
 * Paint a bilinearly interpolated spectrogram into the given plot rectangle.
 * `sample` maps a pixel column to the neighbouring spectra to blend.
 */
export function paintDsaHeatmap(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  sample: (px: number) => ColumnSample,
  dbMin: number,
  dbMax: number,
) {
  const { x, y, w, h } = rect;
  if (w < 1 || h < 1) return;
  const image = ctx.createImageData(w, h);

  for (let px = 0; px < w; px++) {
    const col = sample(px);
    for (let py = 0; py < h; py++) {
      const idx = (py * w + px) * 4;
      const frac = (h - 1 - py) / Math.max(1, h - 1);
      const a = sampleSpectrum(col.lo, frac);
      const b = sampleSpectrum(col.hi, frac);
      let db: number | null;
      if (a != null && b != null) db = a + (b - a) * Math.max(0, Math.min(1, col.f));
      else db = a ?? b;

      if (db == null) {
        image.data[idx] = DSA_BACKDROP[0];
        image.data[idx + 1] = DSA_BACKDROP[1];
        image.data[idx + 2] = DSA_BACKDROP[2];
        image.data[idx + 3] = 255;
        continue;
      }
      const [r, g, bl] = dsaColor(db, dbMin, dbMax);
      image.data[idx] = r;
      image.data[idx + 1] = g;
      image.data[idx + 2] = bl;
      image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, x, y);
}

/**
 * Draw the frequency-band key as a slim colour gutter just outside the plot,
 * so the heat map itself stays unobstructed (as on bedside monitors).
 */
export function drawBandGutter(
  ctx: CanvasRenderingContext2D,
  opts: {
    left: number;
    plotW: number;
    dpr: number;
    yForHz: (hz: number) => number;
    minHz: number;
    maxHz: number;
    fontFamily?: string;
  },
) {
  const { left, plotW, dpr, yForHz, minHz, maxHz } = opts;
  const family = opts.fontFamily ?? '"Inter", system-ui, sans-serif';
  const gutterX = left + plotW + 3 * dpr;
  const gutterW = 4 * dpr;

  for (const band of DSA_BANDS) {
    const lo = Math.max(minHz, band.lo);
    const hi = Math.min(maxHz, band.hi);
    if (hi <= lo) continue;
    const yLo = yForHz(lo);
    const yHi = yForHz(hi);
    ctx.fillStyle = band.color;
    ctx.fillRect(gutterX, yHi, gutterW, Math.max(1, yLo - yHi));

    // Boundary hairline across the heat map, kept faint so colours read true.
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(left, yHi);
    ctx.lineTo(left + plotW, yHi);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = `600 ${9.5 * dpr}px ${family}`;
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(band.label, gutterX + gutterW + 4 * dpr, (yHi + yLo) / 2);
  }
}
