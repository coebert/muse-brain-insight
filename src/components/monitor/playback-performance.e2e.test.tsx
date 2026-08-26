/**
 * End-to-end: playback keeps up with real time, and nothing drifts.
 *
 * Replays a multi-minute synthetic recording through the real analyzer one
 * second at a time and measures how long each second of signal takes to
 * process. Real-time monitoring only works if a second of EEG costs well under
 * a second of CPU — and if, after thousands of ticks, the spectral array time
 * axis, the suppression clock and the tile values still describe exactly the
 * same instant. Both are asserted here.
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
/* Synthetic multi-minute acquisition                                  */
/* ------------------------------------------------------------------ */

const FS = MUSE_SAMPLE_RATE;
const EPOCH_SAMPLES = FS * 4;
const WINDOW_SECONDS = 120;
/** Long enough to expose slow accumulation, short enough for CI. */
const SESSION_SECONDS = 8 * 60;
/** A second of EEG must cost far less than a second of CPU. */
const REALTIME_BUDGET_MS = 1000;
/** Headroom target: worst tick should still leave most of the second free. */
const WORST_TICK_BUDGET_MS = 400;

/** Mixed anaesthetic-like signal with periodic suppression, deterministic. */
function clinicalLikeSignal(seconds: number): Float64Array {
  const out = new Float64Array(seconds * FS);
  let s = 20260826;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < out.length; i += 1) {
    const t = i / FS;
    // Every third minute drifts into a burst-suppression pattern.
    const suppressing = Math.floor(t / 60) % 3 === 2;
    const suppressed = suppressing && t % 2 < 1.2;
    out[i] = suppressed
      ? 1.1 * rand()
      : 30 * Math.sin(2 * Math.PI * 11 * t) + 12 * Math.sin(2 * Math.PI * 2.5 * t) + 6 * rand();
  }
  return out;
}

interface Tick {
  t: number;
  epochs: Epoch[];
  suppressionSeconds: number;
  maxSr: number;
  /** Wall-clock cost of analysing this one second of signal. */
  ms: number;
}

/** Replays the recording exactly as the live monitor does, timing each tick. */
function timedPlayback(signal: Float64Array): Tick[] {
  const analyzer = new EegAnalyzer(undefined, FS);
  const epochs: Epoch[] = [];
  const ticks: Tick[] = [];
  let maxSr = 0;
  for (let start = 0; start + EPOCH_SAMPLES <= signal.length; start += FS) {
    const t = (start + EPOCH_SAMPLES) / FS;
    const window = Float64Array.from(signal.subarray(start, start + EPOCH_SAMPLES));
    const began = performance.now();
    const epoch = analyzer.analyze(window, t);
    const ms = performance.now() - began;
    epochs.push(epoch);
    maxSr = Math.max(maxSr, epoch.suppressionRatio);
    ticks.push({ t, epochs: [...epochs], suppressionSeconds: analyzer.suppressionSeconds, maxSr, ms });
  }
  return ticks;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
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

/** Suppression time as the tile formats it. */
function expectedSuppressionTile(seconds: number): number {
  return seconds < 60 ? Number(seconds.toFixed(0)) : Math.floor(seconds / 60);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/* ------------------------------------------------------------------ */

describe("playback keeps up with real time over a multi-minute session", () => {
  // One expensive replay shared by every assertion in this file.
  const ticks = timedPlayback(clinicalLikeSignal(SESSION_SECONDS));

  beforeEach(() => {
    painted.length = 0;
    stubCanvas();
  });

  it("processes a full multi-minute session", () => {
    expect(ticks.length).toBeGreaterThan(SESSION_SECONDS - 10);
  });

  it("analyses each second of EEG in far less than a second of CPU", () => {
    const costs = ticks.map((tk) => tk.ms);
    const total = costs.reduce((a, b) => a + b, 0);
    const worst = Math.max(...costs);

    // Real-time factor: CPU seconds spent per second of signal.
    expect(total / ticks.length).toBeLessThan(REALTIME_BUDGET_MS);
    expect(worst).toBeLessThan(WORST_TICK_BUDGET_MS);
  });

  it("does not slow down as the session lengthens", () => {
    // Per-epoch work must not grow with history, or long cases fall behind.
    const firstMinute = median(ticks.slice(0, 60).map((tk) => tk.ms));
    const lastMinute = median(ticks.slice(-60).map((tk) => tk.ms));
    const floorMs = 0.5; // timer noise on very fast machines
    expect(lastMinute).toBeLessThan(Math.max(firstMinute * 4, floorMs * 4));
  });

  it("keeps the analyzer clock exactly on the playback clock, tick for tick", () => {
    ticks.forEach((tick, i) => {
      // No skipped, duplicated or reordered seconds anywhere in the session.
      expect(tick.epochs).toHaveLength(i + 1);
      expect(tick.epochs.at(-1)!.t).toBeCloseTo(tick.t, 9);
    });
    const last = ticks.at(-1)!;
    const slots = alignSeries(last.epochs, (e) => e.t, (e) => e.spectrum);
    // Array time axis length equals elapsed analyzer seconds: zero drift.
    expect(slots).toHaveLength(last.epochs.length);
    expect(slots.every((s) => s !== null)).toBe(true);
    expect(last.epochs.at(-1)!.t - last.epochs[0]!.t).toBeCloseTo(last.epochs.length - 1, 6);
  });

  it("shows no measurable drift between the array edge and the tiles at any point", () => {
    // Sampled across the whole session, including the final minutes.
    for (const tick of ticks.filter((_, i) => i >= 30 && i % 47 === 0)) {
      renderMonitor(tick);
      const latest = tick.epochs.at(-1)!;
      expect(newestPaintedSpectrum()).toEqual(latest.spectrum);
      expect(tileValue("Suppression ratio")).toBe(Number(latest.suppressionRatio.toFixed(0)));
      expect(tileValue("Suppression time")).toBe(expectedSuppressionTile(tick.suppressionSeconds));
      cleanup();
    }
  });

  it("renders a late-session frame fast enough to repaint every second", () => {
    const last = ticks.at(-1)!;
    const began = performance.now();
    renderMonitor(last);
    const ms = performance.now() - began;
    expect(newestPaintedSpectrum()).toEqual(last.epochs.at(-1)!.spectrum);
    // Painting a full history must still fit inside one monitoring tick.
    expect(ms).toBeLessThan(REALTIME_BUDGET_MS);
  });
});
