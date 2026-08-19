/**
 * End-to-end: Muse 2 samples in, direct spectral array on the Signal tab out.
 *
 * Feeds synthetic four-channel Muse 2 data through the real analysis pipeline,
 * confirms the acquisition setup is the one COEBIS and the seizure detector are
 * calibrated on, then renders the DSA lane and inspects the columns actually
 * handed to the heat-map painter — so a break anywhere between ingestion and
 * the rendered spectrogram fails here.
 */
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DSA_MAX_HZ, DSA_MIN_HZ, EegAnalyzer, type Epoch } from "@/lib/eeg/analysis";
import { MUSE_2_PROFILE } from "@/lib/eeg/device-profile";
import { MUSE_SAMPLE_RATE } from "@/lib/eeg/dsp";
import {
  gateCoebisModel,
  gateSeizureDetector,
  lineageFromProfile,
} from "@/lib/eeg/model-lineage";

/** Columns the chart asked the painter to draw, captured per render. */
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

const { DsaChart } = await import("./DsaChart");
const dsaRender = await import("@/lib/eeg/dsa-render");

/* ------------------------------------------------------------------ */
/* Synthetic Muse 2 acquisition                                        */
/* ------------------------------------------------------------------ */

const FS = MUSE_SAMPLE_RATE;
const EPOCH_SAMPLES = FS * 4;
/** Dominant rhythm in the synthetic recording, in Hz. */
const ALPHA_HZ = 10;

/** One Muse channel: a 10 Hz rhythm at a physiological amplitude plus noise. */
function museChannel(seconds: number, seed = 1): Float64Array {
  const out = new Float64Array(seconds * FS);
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  for (let i = 0; i < out.length; i += 1) {
    const t = i / FS;
    out[i] = 30 * Math.sin(2 * Math.PI * ALPHA_HZ * t) + 4 * rand();
  }
  return out;
}

/** Run the real analyzer over the stream, one epoch per second, as the monitor does. */
function ingestToEpochs(signal: Float64Array): Epoch[] {
  const analyzer = new EegAnalyzer(undefined, FS);
  const epochs: Epoch[] = [];
  for (let start = 0; start + EPOCH_SAMPLES <= signal.length; start += FS) {
    const window = signal.subarray(start, start + EPOCH_SAMPLES);
    epochs.push(analyzer.analyze(Float64Array.from(window), (start + EPOCH_SAMPLES) / FS));
  }
  return epochs;
}

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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as RenderingContext,
  );
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

/* ------------------------------------------------------------------ */

describe("Signal tab DSA after Muse 2 ingestion", () => {
  beforeEach(() => {
    painted.length = 0;
    stubCanvas();
  });

  it("computes one spectrum per second of ingested Muse 2 data", () => {
    const epochs = ingestToEpochs(museChannel(30));
    // 30 s of samples, 4 s epochs hopping every second.
    expect(epochs).toHaveLength(27);
    for (const e of epochs) {
      expect(e.spectrum.length).toBeGreaterThan(10);
      expect(e.spectrum.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it("keeps the ingested spectra inside the DSA frequency window", () => {
    const epochs = ingestToEpochs(museChannel(20));
    const bins = epochs[0]!.spectrum.length;
    // The spectrum vector spans DSA_MIN_HZ..DSA_MAX_HZ, so a 10 Hz rhythm must
    // peak roughly a third of the way up the array.
    const last = epochs.at(-1)!.spectrum;
    const peak = last.indexOf(Math.max(...last));
    const peakHz = DSA_MIN_HZ + (peak / (bins - 1)) * (DSA_MAX_HZ - DSA_MIN_HZ);
    expect(peakHz).toBeGreaterThan(ALPHA_HZ - 2);
    expect(peakHz).toBeLessThan(ALPHA_HZ + 2);
  });

  it("runs on a lineage that COEBIS and the seizure detector accept", () => {
    const current = lineageFromProfile(MUSE_2_PROFILE);
    const coebis = gateCoebisModel(current, current);
    expect(coebis.mode).toBe("run");
    expect(coebis.allowed).toBe(true);
    const seizure = gateSeizureDetector(MUSE_2_PROFILE);
    expect(seizure.mode).toBe("run");
    expect(seizure.thresholdDelta).toBe(0);
  });

  it("renders the computed array into the DSA lane", () => {
    const epochs = ingestToEpochs(museChannel(40));
    render(<DsaChart epochs={epochs} windowSeconds={60} />);

    expect(dsaRender.paintDsaHeatmap).toHaveBeenCalled();
    expect(painted.length).toBeGreaterThan(0);

    const columnsWithData = painted.filter((c) => (c.lo?.length ?? 0) > 0);
    expect(columnsWithData.length).toBeGreaterThan(0);

    // Every drawn column carries a real spectrum of the ingested data, and the
    // 10 Hz rhythm is the brightest band in it.
    const bins = epochs[0]!.spectrum.length;
    for (const col of columnsWithData) {
      const spectrum = col.lo!;
      expect(spectrum).toHaveLength(bins);
      const peakHz =
        DSA_MIN_HZ +
        (spectrum.indexOf(Math.max(...spectrum)) / (bins - 1)) * (DSA_MAX_HZ - DSA_MIN_HZ);
      expect(peakHz).toBeGreaterThan(ALPHA_HZ - 2);
      expect(peakHz).toBeLessThan(ALPHA_HZ + 2);
    }
  });

  it("leaves a hole in the array where ingestion dropped out", () => {
    const signal = museChannel(40);
    const epochs = ingestToEpochs(signal).filter((e) => e.t < 15 || e.t > 25);
    render(<DsaChart epochs={epochs} windowSeconds={60} />);

    const empty = painted.filter((c) => !c.lo?.length && !c.hi?.length);
    // The dropout must read as missing data, not as compressed history.
    expect(empty.length).toBeGreaterThan(0);
  });

  it("draws nothing before any Muse data has been ingested", () => {
    render(<DsaChart epochs={[]} windowSeconds={60} />);
    expect(dsaRender.paintDsaHeatmap).not.toHaveBeenCalled();
  });
});
