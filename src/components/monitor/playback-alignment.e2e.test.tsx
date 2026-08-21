/**
 * End-to-end: the spectral array and the suppression tiles stay on one clock.
 *
 * Plays a synthetic burst-suppression recording back through the real analyzer
 * one second at a time, and after every tick re-renders the DSA lane and the
 * metrics grid together. At each tick it checks that the right-hand edge of the
 * spectral array, the suppression-ratio tile and the suppression-time tile all
 * describe the same analyzer timestamp — so a lag, a stale tile or a shifted
 * time axis in any one of the three fails here.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, EegAnalyzer, type Epoch } from "@/lib/eeg/analysis";
import { MUSE_SAMPLE_RATE } from "@/lib/eeg/dsp";
import { alignSeries } from "@/lib/eeg/gaps";

/** Columns the chart handed to the heat-map painter, captured per render. */
const painted: { lo?: number[] | undefined; hi?: number[] | undefined; f: number }[] = [];

vi.mock("@/lib/eeg/dsa-render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/eeg/dsa-render")>();
  return {
    ...actual,
    drawBandGutter: vi.fn(),
    paintDsaHeatmap: vi.fn(
      (
        _ctx: unknown,
        rect: { w: number; h: number },
        sample: (px: number) => { lo?: number[]; hi?: number[]; f: number },
      ) => {
        for (let px = 0; px < Math.max(1, Math.floor(rect.w)); px += 1) painted.push(sample(px));
      },
    ),
  };
});
vi.mock("@/hooks/useCoebisModel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useCoebisModel")>()),
  useCoebisModel: () => null,
}));
vi.mock("@/hooks/useSefAlignment", () => ({ useSefAlignment: () => null }));

const { DsaChart } = await import("./DsaChart");
const { MetricsGrid } = await import("./MetricsGrid");

/* ------------------------------------------------------------------ */
/* Synthetic acquisition, played back one second at a time             */
/* ------------------------------------------------------------------ */

const FS = MUSE_SAMPLE_RATE;
const EPOCH_SAMPLES = FS * 4;
const WINDOW_SECONDS = 120;

/** Alternating suppressed and bursting seconds, at a known duty cycle. */
function burstSuppression(seconds: number, suppressedFraction: number): Float64Array {
  const out = new Float64Array(seconds * FS);
  let s = 7;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < out.length; i += 1) {
    const t = i / FS;
    const suppressed = t % 2 < 2 * suppressedFraction;
    out[i] = suppressed ? 1.2 * rand() : 40 * Math.sin(2 * Math.PI * 12 * t) + 5 * rand();
  }
  return out;
}

interface Tick {
  /** Epoch produced at this second, or null when ingestion dropped out. */
  epoch: Epoch | null;
  /** Everything the monitor holds after this tick. */
  epochs: Epoch[];
  /** Analyzer suppression clock at this tick. */
  suppressionSeconds: number;
  maxSr: number;
}

/**
 * Replays the recording exactly as the live monitor does — one analyzer call
 * per second — and snapshots the monitor's state after every tick.
 */
function playback(signal: Float64Array, dropout?: (t: number) => boolean): Tick[] {
  const analyzer = new EegAnalyzer(undefined, FS);
  const epochs: Epoch[] = [];
  const ticks: Tick[] = [];
  let maxSr = 0;
  for (let start = 0; start + EPOCH_SAMPLES <= signal.length; start += FS) {
    const t = (start + EPOCH_SAMPLES) / FS;
    if (dropout?.(t)) {
      ticks.push({ epoch: null, epochs: [...epochs], suppressionSeconds: analyzer.suppressionSeconds, maxSr });
      continue;
    }
    const epoch = analyzer.analyze(Float64Array.from(signal.subarray(start, start + EPOCH_SAMPLES)), t);
    epochs.push(epoch);
    maxSr = Math.max(maxSr, epoch.suppressionRatio);
    ticks.push({ epoch, epochs: [...epochs], suppressionSeconds: analyzer.suppressionSeconds, maxSr });
  }
  return ticks;
}

/* ------------------------------------------------------------------ */
/* Rendering the two surfaces side by side                             */
/* ------------------------------------------------------------------ */

/** jsdom has no canvas backend; the chart only needs a context and a box. */
function stubCanvas(width = 240, height = 120) {
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "createImageData")
          return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
        if (prop === "canvas") return null;
        if (prop === "measureText") return () => ({ width: 10 });
        return () => undefined;
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as RenderingContext);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  } as DOMRect);
}

function renderMonitor(tick: Tick) {
  painted.length = 0;
  render(
    <>
      <DsaChart epochs={tick.epochs} windowSeconds={WINDOW_SECONDS} />
      <MetricsGrid
        latest={tick.epochs.at(-1) ?? null}
        summary={{ maxSr: tick.maxSr, suppressionSeconds: tick.suppressionSeconds, seizureAlerts: 0 }}
        srWindowSeconds={DEFAULT_SETTINGS.srWindowSeconds}
        srTone="caution"
        seizureAlert={false}
        icuMode
        depthWindow={{
          status: { state: "inside", since: null, message: "" } as never,
          prefs: { enabled: false, low: 40, high: 60, graceSeconds: 60 } as never,
        }}
      />
    </>,
  );
}

/** The number rendered on a named tile. */
function tileValue(label: string): number {
  let node: HTMLElement | null = screen.getByText(new RegExp(`^${label}`, "i")) as HTMLElement;
  let valueEl: HTMLElement | null = null;
  while (node && !valueEl) {
    valueEl = node.querySelector<HTMLElement>(".metric-value");
    node = node.parentElement;
  }
  const match = (valueEl?.textContent ?? "").match(/-?\d+(\.\d+)?/);
  return Number(match?.[0]);
}

/** The spectrum drawn at the newest edge of the array. */
function newestPaintedSpectrum(): number[] | undefined {
  for (let i = painted.length - 1; i >= 0; i -= 1) {
    const col = painted[i]!;
    if (col.lo?.length) return col.lo;
    if (col.hi?.length) return col.hi;
  }
  return undefined;
}

/** Suppression time as the tile formats it, for comparison with the tile. */
function expectedSuppressionTile(seconds: number): number {
  return seconds < 60 ? Number(seconds.toFixed(0)) : Math.floor(seconds / 60);
}

/* ------------------------------------------------------------------ */

describe("spectral array and suppression tiles share one analyzer clock", () => {
  beforeEach(() => {
    painted.length = 0;
    stubCanvas();
  });

  it("gives every playback tick one array slot and one set of tile values", () => {
    const ticks = playback(burstSuppression(90, 0.5));
    expect(ticks.length).toBeGreaterThan(60);
    ticks.forEach((tick, i) => {
      // One epoch per elapsed second: the array timeline and the tile source
      // are the same list, so they cannot drift apart.
      expect(tick.epochs).toHaveLength(i + 1);
      expect(tick.epochs.at(-1)!.t).toBeCloseTo(tick.epoch!.t, 6);
      const slots = alignSeries(tick.epochs, (e) => e.t, (e) => e.spectrum);
      expect(slots).toHaveLength(i + 1);
      expect(slots.every((s) => s !== null)).toBe(true);
    });
  });

  it("shows the newest spectrum and the newest suppression numbers at the same instant", () => {
    const ticks = playback(burstSuppression(90, 0.5));
    // Sample across the recording rather than rendering every second.
    for (const tick of ticks.filter((_, i) => i >= 10 && i % 12 === 0)) {
      renderMonitor(tick);
      const latest = tick.epochs.at(-1)!;

      // The right-hand edge of the array is this tick's spectrum...
      expect(newestPaintedSpectrum()).toEqual(latest.spectrum);
      // ...and both suppression tiles describe that same epoch.
      expect(tileValue("Suppression ratio")).toBe(Number(latest.suppressionRatio.toFixed(0)));
      expect(tileValue("Suppression time")).toBe(expectedSuppressionTile(tick.suppressionSeconds));
      cleanup();
    }
  });

  it("advances the array and both tiles together, never one without the others", () => {
    const ticks = playback(burstSuppression(120, 0.5));
    let previousColumns = 0;
    let previousSuppression = -1;
    for (const tick of ticks.filter((_, i) => i >= 5 && i % 10 === 0)) {
      renderMonitor(tick);
      const columns = alignSeries(tick.epochs, (e) => e.t, (e) => e.spectrum).length;

      // The array grew, the suppression clock advanced, and the ratio tile
      // still matches the epoch at the array's right edge.
      expect(columns).toBeGreaterThan(previousColumns);
      expect(tick.suppressionSeconds).toBeGreaterThan(previousSuppression);
      expect(newestPaintedSpectrum()).toEqual(tick.epochs.at(-1)!.spectrum);
      expect(tileValue("Suppression ratio")).toBe(
        Number(tick.epochs.at(-1)!.suppressionRatio.toFixed(0)),
      );

      previousColumns = columns;
      previousSuppression = tick.suppressionSeconds;
      cleanup();
    }
  });

  it("holds the suppression clock and the array edge still through a dropout", () => {
    const ticks = playback(burstSuppression(120, 0.5), (t) => t >= 60 && t < 75);
    const during = ticks.filter((tk) => tk.epoch === null);
    expect(during.length).toBeGreaterThan(5);

    const frozen = during[0]!;
    const stillFrozen = during.at(-1)!;
    // Nothing was analysed, so neither surface may invent progress.
    expect(stillFrozen.epochs).toHaveLength(frozen.epochs.length);
    expect(stillFrozen.suppressionSeconds).toBe(frozen.suppressionSeconds);

    renderMonitor(stillFrozen);
    expect(newestPaintedSpectrum()).toEqual(stillFrozen.epochs.at(-1)!.spectrum);
    expect(tileValue("Suppression time")).toBe(expectedSuppressionTile(stillFrozen.suppressionSeconds));
  });

  it("resumes with a hole in the array and no lost suppression time", () => {
    const ticks = playback(burstSuppression(120, 0.5), (t) => t >= 60 && t < 75);
    const last = ticks.at(-1)!;
    const slots = alignSeries(last.epochs, (e) => e.t, (e) => e.spectrum);

    // The array keeps the dropout as an empty stretch on the time axis rather
    // than closing up, so array time still equals analyzer time.
    const missing = slots.filter((s) => s === null).length;
    expect(missing).toBeGreaterThan(10);
    expect(slots.length - missing).toBe(last.epochs.length);
    const spanSeconds = last.epochs.at(-1)!.t - last.epochs[0]!.t + 1;
    expect(slots.length).toBe(Math.round(spanSeconds));

    renderMonitor(last);
    expect(painted.some((c) => !c.lo?.length && !c.hi?.length)).toBe(true);
    expect(tileValue("Suppression time")).toBe(expectedSuppressionTile(last.suppressionSeconds));
    // Time suppressed only ever accumulates from analysed seconds.
    expect(last.suppressionSeconds).toBeLessThanOrEqual(last.epochs.length);
  });

  it("keeps the peak suppression readout consistent with the played-back epochs", () => {
    const ticks = playback(burstSuppression(120, 0.5));
    const last = ticks.at(-1)!;
    renderMonitor(last);
    const peak = Math.max(...last.epochs.map((e) => e.suppressionRatio));
    expect(last.maxSr).toBeCloseTo(peak, 6);
    expect(screen.getByText(new RegExp(`Peak ${peak.toFixed(0)} %`))).toBeTruthy();
  });
});
