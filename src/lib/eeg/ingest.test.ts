import { describe, expect, it, vi } from "vitest";

import {
  IngestPipeline,
  Resampler,
  checkAmplitude,
  describeChannelMap,
  inferRateFromTime,
  inferUnit,
  parseEegCsv,
  parseStreamLine,
  resample,
  suggestChannelMap,
  unitScale,
  EMPTY_CHANNEL_MAP,
} from "./ingest";
import { MUSE_SAMPLE_RATE } from "./dsp";

function sine(n: number, fs: number, hz: number, amp = 1): number[] {
  return Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / fs));
}

describe("unit normalisation", () => {
  it("converts each unit to microvolts", () => {
    expect(unitScale("uV")).toBe(1);
    expect(unitScale("mV")).toBe(1000);
    expect(unitScale("V")).toBe(1_000_000);
    expect(unitScale("counts", 0.02235)).toBeCloseTo(0.02235);
    expect(unitScale("counts", 0)).toBe(1);
  });

  it("infers the unit from signal amplitude", () => {
    expect(inferUnit(sine(500, 256, 10, 50)).unit).toBe("uV");
    expect(inferUnit(sine(500, 256, 10, 0.05)).unit).toBe("mV");
    expect(inferUnit(sine(500, 256, 10, 0.00005)).unit).toBe("V");
    expect(inferUnit(sine(500, 256, 10, 40000)).unit).toBe("counts");
  });

  it("flags implausible amplitudes after scaling", () => {
    expect(checkAmplitude(sine(500, 256, 10, 50), 1).ok).toBe(true);
    expect(checkAmplitude(sine(500, 256, 10, 50), 1000).ok).toBe(false);
    expect(checkAmplitude(sine(500, 256, 10, 50), 0.001).ok).toBe(false);
    expect(checkAmplitude([0, 0, 0], 1).ok).toBe(false);
  });
});

describe("resampling", () => {
  it("keeps the output rate close to the target", () => {
    const out = resample(sine(1000, 500, 10), 500, 250);
    expect(out.length).toBeGreaterThan(490);
    expect(out.length).toBeLessThan(510);
  });

  it("upsamples as well as downsamples", () => {
    const out = resample(sine(128, 128, 5), 128, 256);
    expect(out.length).toBeGreaterThan(250);
  });

  it("passes through unchanged when the rates match", () => {
    const input = sine(64, 256, 8);
    expect(Array.from(resample(input, 256, 256))).toEqual(input);
  });

  it("does not introduce a step at chunk boundaries", () => {
    const input = sine(600, 500, 7, 40);
    const whole = resample(input, 500, 250);
    const streamed: number[] = [];
    const r = new Resampler(500, 250);
    for (let i = 0; i < input.length; i += 37)
      streamed.push(...Array.from(r.process(input.slice(i, i + 37))));
    expect(streamed.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++)
      expect(streamed[i]!).toBeCloseTo(whole[i]!, 10);
  });

  it("preserves the waveform frequency", () => {
    const out = Array.from(resample(sine(2000, 500, 10, 100), 500, 250));
    // Zero crossings of a 10 Hz sine over 4 s ≈ 80.
    let crossings = 0;
    for (let i = 1; i < out.length; i++)
      if ((out[i - 1]! < 0 && out[i]! >= 0) || (out[i - 1]! > 0 && out[i]! <= 0)) crossings++;
    expect(crossings).toBeGreaterThan(75);
    expect(crossings).toBeLessThan(85);
  });

  it("rejects nonsensical rates", () => {
    expect(() => new Resampler(0, 256)).toThrow();
  });
});

describe("CSV parsing", () => {
  it("reads a headed comma file with a time column", () => {
    const rows = ["time,TP9,AF7,AF8,TP10"];
    for (let i = 0; i < 300; i++)
      rows.push([(i / 128).toFixed(6), i, i + 1, i + 2, i + 3].join(","));
    const parsed = parseEegCsv(rows.join("\n"));
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.columns).toEqual(["time", "TP9", "AF7", "AF8", "TP10"]);
    expect(parsed.timeColumn).toBe(0);
    expect(parsed.inferredRate).toBeCloseTo(128, 0);
    expect(parsed.rowCount).toBe(300);
  });

  it("handles tab-separated headerless data", () => {
    const rows: string[] = [];
    for (let i = 0; i < 50; i++) rows.push(`${i}\t${i * 2}`);
    const parsed = parseEegCsv(rows.join("\n"));
    expect(parsed.hasHeader).toBe(false);
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.columns).toEqual(["col 1", "col 2"]);
  });

  it("reads millisecond timestamps at the right rate", () => {
    const times = Array.from({ length: 200 }, (_, i) => i * (1000 / 250));
    expect(inferRateFromTime(times)?.rate).toBeCloseTo(250, 0);
    expect(inferRateFromTime(times)?.unit).toBe("ms");
  });

  it("skips comments and short rows", () => {
    const text = ["# exported by rig", "a,b", "1,2", "3", "4,5"].join("\n");
    const parsed = parseEegCsv(text);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.warnings.join(" ")).toMatch(/short row/);
  });

  it("throws on an empty file", () => {
    expect(() => parseEegCsv("   \n\n")).toThrow();
  });
});

describe("channel mapping", () => {
  it("matches electrode names exactly", () => {
    const map = suggestChannelMap(["TP9", "AF7", "AF8", "TP10"]);
    expect(map.AF7).toBe("AF7");
    expect(map.TP10).toBe("TP10");
  });

  it("understands 10-20 aliases from other headsets", () => {
    const map = suggestChannelMap(["Fp1", "Fp2"]);
    expect(map.AF7).toBe("Fp1");
    expect(map.AF8).toBe("Fp2");
  });

  it("explains a one-sided montage", () => {
    const described = describeChannelMap({ ...EMPTY_CHANNEL_MAP, TP9: "c1", AF7: "c2" });
    expect(described.bilateral).toBe(false);
    expect(described.missing).toEqual(["AF8", "TP10"]);
    expect(described.note).toMatch(/one side only/);
  });

  it("reports a complete montage", () => {
    const described = describeChannelMap(suggestChannelMap(["TP9", "AF7", "AF8", "TP10"]));
    expect(described.mapped).toHaveLength(4);
    expect(described.bilateral).toBe(true);
  });
});

describe("stream line parsing", () => {
  const columns = ["TP9", "AF7"];

  it("parses delimited numbers", () => {
    expect(parseStreamLine("12.5, -3", columns)).toEqual({ TP9: [12.5], AF7: [-3] });
  });

  it("parses JSON arrays and chunks", () => {
    expect(parseStreamLine("[1,2]", columns)).toEqual({ TP9: [1], AF7: [2] });
    expect(parseStreamLine('{"data":[[1,2],[3,4]]}', columns)).toEqual({
      TP9: [1, 3],
      AF7: [2, 4],
    });
  });

  it("parses named JSON channels", () => {
    expect(parseStreamLine('{"TP9":[1,2],"AF7":3}', columns)).toEqual({ TP9: [1, 2], AF7: [3] });
  });

  it("ignores comments and malformed lines", () => {
    expect(parseStreamLine("# hello", columns)).toBeNull();
    expect(parseStreamLine("{oops", columns)).toBeNull();
    expect(parseStreamLine("   ", columns)).toBeNull();
  });
});

describe("ingest pipeline", () => {
  it("scales, resamples and dispatches onto analysis electrodes", () => {
    const emitted: Record<string, number[]> = {};
    const pipeline = new IngestPipeline(
      {
        sampleRate: 128,
        unit: "mV",
        channelMap: { TP9: "a", AF7: "a", AF8: "b", TP10: null },
      },
      (channel, samples) => {
        emitted[channel] = [...(emitted[channel] ?? []), ...Array.from(samples)];
      },
    );
    expect(pipeline.mappedCount).toBe(3);
    pipeline.push({ a: [0.05, 0.05, 0.05, 0.05], b: [0.01, 0.01, 0.01, 0.01] });
    // 128 Hz in, 256 Hz out: roughly twice as many samples.
    expect(emitted["TP9"]!.length).toBeGreaterThan(6);
    expect(emitted["TP9"]![0]).toBeCloseTo(50); // 0.05 mV → 50 µV
    expect(emitted["AF7"]).toEqual(emitted["TP9"]);
    expect(emitted["AF8"]![0]).toBeCloseTo(10);
    expect(emitted["TP10"]).toBeUndefined();
  });

  it("holds dropped samples at zero rather than emitting NaN", () => {
    const seen: number[] = [];
    const pipeline = new IngestPipeline(
      { sampleRate: MUSE_SAMPLE_RATE, unit: "uV", channelMap: { ...EMPTY_CHANNEL_MAP, TP9: "a" } },
      (_c, samples) => seen.push(...Array.from(samples)),
    );
    pipeline.push({ a: [10, Number.NaN, 20] });
    expect(seen.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("ignores columns that are not mapped", () => {
    const handler = vi.fn();
    const pipeline = new IngestPipeline(
      { sampleRate: 256, unit: "uV", channelMap: { ...EMPTY_CHANNEL_MAP, TP9: "a" } },
      handler,
    );
    pipeline.push({ other: [1, 2, 3] });
    expect(handler).not.toHaveBeenCalled();
  });
});
