/**
 * End-to-end: dropouts, reconnects and corrupted packets during playback.
 *
 * Replays a Muse 2-shaped stream through the real ingest path (per-sample
 * filter chain into ring buffers) and the real analyzer, while injecting the
 * three failure modes a headband actually produces:
 *   - dropouts: the link goes quiet for tens of seconds,
 *   - reconnects: the source restarts and filter state is re-initialised,
 *   - corrupted packets: NaN/Infinity, truncated frames and absurd spikes.
 *
 * It then checks the monitor keeps processing and that nothing misaligns:
 * epoch timestamps stay on the one-second grid, the aligned array keeps holes
 * where the data was missing instead of closing up, the suppression clock only
 * counts analysed seconds, no metric goes non-finite, and the spectral array's
 * newest column and the suppression tiles still describe the same epoch.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS, EegAnalyzer, type Epoch } from "@/lib/eeg/analysis";
import { MUSE_SAMPLE_RATE, makeEegFilter } from "@/lib/eeg/dsp";
import { alignSeries, detectGaps, nullRuns } from "@/lib/eeg/gaps";

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
/* Simulated acquisition                                               */
/* ------------------------------------------------------------------ */

const FS = MUSE_SAMPLE_RATE;
const EPOCH_SECONDS = 4;
const EPOCH_LEN = FS * EPOCH_SECONDS;
const BUFFER_LEN = FS * 60;
const CHUNK = 12; // samples per Bluetooth notification
const STALE_SAMPLE_SECONDS = 2.5; // matches the monitor's stale-sample watchdog
const WINDOW_SECONDS = 120;

type Fault = "ok" | "dropout" | "nan" | "spike" | "truncated";

interface Buf {
  data: Float64Array;
  write: number;
  count: number;
  filter: ReturnType<typeof makeEegFilter>;
}

const makeBuf = (): Buf => ({
  data: new Float64Array(BUFFER_LEN),
  write: 0,
  count: 0,
  filter: makeEegFilter(),
});

function readLast(buf: Buf, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = buf.data[(buf.write - n + i + BUFFER_LEN * 2) % BUFFER_LEN]!;
  }
  return out;
}

/** Deterministic anaesthesia-like EEG with periodic suppressed stretches. */
function cleanSample(t: number, rnd: () => number): number {
  const suppressed = t % 10 < 4;
  return suppressed
    ? 1.2 * rnd()
    : 40 * Math.sin(2 * Math.PI * 10 * t) + 16 * Math.sin(2 * Math.PI * 2 * t) + 4 * rnd();
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff - 0.5;
  };
}

interface Tick {
  t: number;
  epoch: Epoch | null;
  epochs: Epoch[];
  suppressionSeconds: number;
  maxSr: number;
}

interface Session {
  ticks: Tick[];
  epochs: Epoch[];
  /** Seconds during which no packets were delivered. */
  droppedSeconds: number[];
  reconnects: number[];
}

/**
 * Replays a session second by second. `faultAt` decides what the link does at
 * each whole second; a `dropout` second delivers no packets at all, and the
 * first clean second after a dropout counts as a reconnect (filters reset,
 * timeline preserved — exactly what the monitor does on re-open).
 */
function playback(seconds: number, faultAt: (t: number) => Fault): Session {
  const buf = makeBuf();
  const analyzer = new EegAnalyzer(DEFAULT_SETTINGS, FS);
  const rnd = makeRng(4711);
  const spike = makeRng(99);

  const ticks: Tick[] = [];
  const epochs: Epoch[] = [];
  const droppedSeconds: number[] = [];
  const reconnects: number[] = [];
  let lastSampleAt = 0; // seconds
  let wasDown = false;
  let maxSr = 0;

  for (let sec = 0; sec < seconds; sec += 1) {
    const fault = faultAt(sec);
    if (fault === "dropout") {
      droppedSeconds.push(sec);
      wasDown = true;
    } else {
      if (wasDown) {
        // Reconnect: the source re-opens, so the streaming filter restarts.
        buf.filter.reset();
        reconnects.push(sec);
        wasDown = false;
      }
      for (let off = 0; off < FS; off += CHUNK) {
        // A truncated frame delivers fewer samples than promised.
        const n = fault === "truncated" && off % 48 === 0 ? 5 : CHUNK;
        for (let i = 0; i < n; i += 1) {
          const t = sec + (off + i) / FS;
          let raw = cleanSample(t, rnd);
          if (fault === "nan" && (off + i) % 7 === 0) {
            raw = (off + i) % 21 === 0 ? Number.NaN : Number.POSITIVE_INFINITY;
          } else if (fault === "spike" && (off + i) % 31 === 0) {
            raw = 4e6 * spike();
          }
          const v = buf.filter.process(raw);
          buf.data[buf.write] = v;
          buf.write = (buf.write + 1) % BUFFER_LEN;
          if (buf.count < BUFFER_LEN) buf.count += 1;
        }
      }
      lastSampleAt = sec + 1;
    }

    // --- per-second analysis tick ------------------------------------------
    const t = sec + 1;
    if (buf.count < EPOCH_LEN) {
      ticks.push({ t, epoch: null, epochs: [...epochs], suppressionSeconds: analyzer.suppressionSeconds, maxSr });
      continue;
    }
    if (t - lastSampleAt > STALE_SAMPLE_SECONDS) {
      // Stale buffer: the monitor records a gap instead of re-analysing.
      ticks.push({ t, epoch: null, epochs: [...epochs], suppressionSeconds: analyzer.suppressionSeconds, maxSr });
      continue;
    }
    const epoch = analyzer.analyze(readLast(buf, EPOCH_LEN), t);
    epochs.push(epoch);
    maxSr = Math.max(maxSr, epoch.suppressionRatio);
    ticks.push({ t, epoch, epochs: [...epochs], suppressionSeconds: analyzer.suppressionSeconds, maxSr });
  }

  return { ticks, epochs, droppedSeconds, reconnects };
}

const inRange = (t: number, from: number, to: number) => t >= from && t < to;

/** 5 minutes with two dropouts, a burst of corrupted packets and spikes. */
const faultSchedule = (t: number): Fault => {
  if (inRange(t, 70, 95) || inRange(t, 200, 215)) return "dropout";
  if (inRange(t, 120, 130)) return "nan";
  if (inRange(t, 150, 155)) return "truncated";
  if (inRange(t, 240, 246)) return "spike";
  return "ok";
};

/* ------------------------------------------------------------------ */
/* Rendering harness                                                   */
/* ------------------------------------------------------------------ */

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

function newestPaintedSpectrum(): number[] | undefined {
  for (let i = painted.length - 1; i >= 0; i -= 1) {
    const col = painted[i]!;
    if (col.lo?.length) return col.lo;
    if (col.hi?.length) return col.hi;
  }
  return undefined;
}

const expectedSuppressionTile = (seconds: number) =>
  seconds < 60 ? Number(seconds.toFixed(0)) : Math.floor(seconds / 60);

/* ------------------------------------------------------------------ */

describe("playback survives dropouts, reconnects and corrupted packets", () => {
  const session = playback(300, faultSchedule);

  beforeEach(() => {
    painted.length = 0;
    stubCanvas();
  });

  it("keeps producing epochs after every dropout and reconnect", () => {
    expect(session.reconnects.length).toBe(2);
    expect(session.epochs.length).toBeGreaterThan(200);
    // Analysis resumes within a few seconds of each reconnect.
    for (const r of session.reconnects) {
      expect(session.epochs.some((e) => e.t > r && e.t <= r + 6)).toBe(true);
    }
    // The last stretch of the session is fully analysed again.
    const tail = session.epochs.filter((e) => e.t > 260);
    expect(tail.length).toBe(300 - 260);
  });

  it("leaves the missing time as holes on the array axis instead of closing up", () => {
    const slots = alignSeries(session.epochs, (e) => e.t, (e) => e.spectrum);
    const span = session.epochs.at(-1)!.t - session.epochs[0]!.t + 1;
    expect(slots.length).toBe(Math.round(span));
    expect(slots.length - slots.filter((s) => s === null).length).toBe(session.epochs.length);

    // One hole per dropout, each at least as long as the dropout itself.
    const runs = nullRuns(slots);
    expect(runs.length).toBe(2);
    const gaps = detectGaps(session.epochs.map((e) => e.t));
    expect(gaps.length).toBe(2);
    expect(gaps[0]!.seconds).toBeGreaterThanOrEqual(25);
    expect(gaps[1]!.seconds).toBeGreaterThanOrEqual(15);
  });

  it("keeps epoch timestamps strictly on the one-second grid", () => {
    for (let i = 1; i < session.epochs.length; i += 1) {
      const step = session.epochs[i]!.t - session.epochs[i - 1]!.t;
      expect(step).toBeGreaterThan(0);
      expect(Number.isInteger(step)).toBe(true);
    }
  });

  it("never emits a non-finite metric, even on corrupted packets", () => {
    for (const e of session.epochs) {
      expect(Number.isFinite(e.suppressionRatio)).toBe(true);
      expect(Number.isFinite(e.epochSuppression)).toBe(true);
      expect(Number.isFinite(e.sef95)).toBe(true);
      expect(Number.isFinite(e.amplitudeUv)).toBe(true);
      expect(Number.isFinite(e.seizureScore)).toBe(true);
      expect(e.spectrum.every((v) => Number.isFinite(v))).toBe(true);
    }
    expect(Number.isFinite(session.ticks.at(-1)!.suppressionSeconds)).toBe(true);
  });

  it("recovers clean spectra after a corrupted-packet burst", () => {
    // Epochs well clear of the corrupted seconds look like real EEG again:
    // finite power and a plausible spectral edge.
    const after = session.epochs.filter((e) => e.t > 135 && e.t < 150);
    expect(after.length).toBeGreaterThan(5);
    for (const e of after) {
      expect(e.sef95).toBeGreaterThan(0);
      expect(e.sef95).toBeLessThan(45);
    }
  });

  it("counts only analysed seconds towards the suppression clock", () => {
    const last = session.ticks.at(-1)!;
    expect(last.suppressionSeconds).toBeLessThanOrEqual(session.epochs.length);
    // The clock never runs backwards and never advances during a dropout.
    let previous = 0;
    for (const tick of session.ticks) {
      expect(tick.suppressionSeconds).toBeGreaterThanOrEqual(previous);
      if (tick.epoch === null) expect(tick.suppressionSeconds).toBe(previous);
      previous = tick.suppressionSeconds;
    }
  });

  it("holds the array edge and both tiles still through a dropout", () => {
    const during = session.ticks.filter((tk) => tk.t > 76 && tk.t <= 95 && tk.epoch === null);
    expect(during.length).toBeGreaterThan(10);
    const first = during[0]!;
    const last = during.at(-1)!;
    expect(last.epochs.length).toBe(first.epochs.length);
    expect(last.suppressionSeconds).toBe(first.suppressionSeconds);

    renderMonitor(last);
    expect(newestPaintedSpectrum()).toEqual(last.epochs.at(-1)!.spectrum);
    expect(tileValue("Suppression ratio")).toBe(
      Number(last.epochs.at(-1)!.suppressionRatio.toFixed(0)),
    );
    expect(tileValue("Suppression time")).toBe(expectedSuppressionTile(last.suppressionSeconds));
  });

  it("keeps the array edge and the tiles on one epoch across every fault", () => {
    const checkpoints = session.ticks.filter(
      (tk) => tk.epoch !== null && [60, 100, 128, 152, 220, 244, 299].includes(tk.t),
    );
    expect(checkpoints.length).toBeGreaterThanOrEqual(5);
    for (const tick of checkpoints) {
      renderMonitor(tick);
      const latest = tick.epochs.at(-1)!;
      expect(latest.t).toBe(tick.t);
      expect(newestPaintedSpectrum()).toEqual(latest.spectrum);
      expect(tileValue("Suppression ratio")).toBe(Number(latest.suppressionRatio.toFixed(0)));
      expect(tileValue("Suppression time")).toBe(expectedSuppressionTile(tick.suppressionSeconds));
      // The painted axis still contains the dropout holes at this point.
      if (tick.t > 100) expect(painted.some((c) => !c.lo?.length && !c.hi?.length)).toBe(true);
      cleanup();
    }
  });
});
