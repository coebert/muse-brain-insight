import { describe, expect, it } from "vitest";

import {
  buildMoaasDepthPoints,
  detectSampleRate,
  dose1ClockSeconds,
  dose1DepthLineageKey,
  moaasAnchor,
  moaasIntervals,
  moaasState,
  parseDose1RawCsv,
} from "../dose1-raw";
import type { ReplayFrame } from "../replay";

const HEADER =
  "Time,Intellivue/ECG_II,Intellivue/EEG_1,Intellivue/EEG_2,EVENT,Misc,SOC,MOAAS,Propofol\n";

function rawCsv(rows: number, opts: { moaasAt?: Record<number, number> } = {}): string {
  const moaasAt = opts.moaasAt ?? {};
  let out = HEADER;
  for (let i = 0; i < rows; i++) {
    const ms = i * 8; // 125 Hz
    const stamp = new Date(Date.UTC(2022, 0, 1, 0, 0, 0, 0) + ms)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    const uv = Math.sin(i / 5) * 20;
    const moaas = moaasAt[i] != null ? String(moaasAt[i]) : "";
    out += `${stamp},0.1,${uv.toFixed(4)},${(uv / 2).toFixed(4)},,,,${moaas},\n`;
  }
  return out;
}

describe("DOSE-I raw parsing", () => {
  it("reads timestamps, EEG samples and MOAA/S annotations", () => {
    const rec = parseDose1RawCsv(rawCsv(1250, { moaasAt: { 0: 5, 625: 2 } }));
    expect(rec.sampleRate).toBe(125);
    expect(rec.samples.length).toBeGreaterThan(1200);
    expect(rec.durationSeconds).toBeGreaterThan(9);
    expect(rec.observations).toEqual([
      { atSeconds: 0, score: 5 },
      { atSeconds: 5, score: 2 },
    ]);
  });

  it("selects the requested channel and rejects an unknown one", () => {
    const csv = rawCsv(100);
    expect(parseDose1RawCsv(csv, { channel: "EEG_2" }).samples.length).toBeGreaterThan(0);
    expect(() => parseDose1RawCsv("Time,Intellivue/PLETH\n2022-01-01 00:00:00.000,1\n")).toThrow(
      /no EEG_1 column/,
    );
  });

  it("detects the sample rate from the median gap", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ t: i / 250, uv: 0 }));
    expect(detectSampleRate(pts)).toBe(250);
  });

  it("parses the published timestamp format", () => {
    expect(dose1ClockSeconds("2022-01-01 00:02:28.059")).toBeCloseTo(
      Date.parse("2022-01-01T00:02:28.059Z") / 1000,
      3,
    );
    expect(dose1ClockSeconds("")).toBeNull();
  });
});

describe("MOAA/S reference mapping", () => {
  it("anchors each level on the 0-100 scale with a widening spread", () => {
    expect(moaasAnchor(5)!.depth).toBe(93);
    expect(moaasAnchor(0)!.depth).toBe(50);
    expect(moaasAnchor(0)!.sigma).toBeGreaterThan(moaasAnchor(5)!.sigma);
    expect(moaasAnchor(9)).toBeNull();
  });

  it("maps levels onto the shared state vocabulary", () => {
    expect(moaasState(5)).toBe("awake");
    expect(moaasState(3)).toBe("sedated");
    expect(moaasState(1)).toBe("anaesthetised");
  });

  it("keeps a stable run open until the score changes", () => {
    const runs = moaasIntervals(
      [
        { atSeconds: 0, score: 5 },
        { atSeconds: 100, score: 5 },
        { atSeconds: 300, score: 2 },
      ],
      600,
    );
    expect(runs).toEqual([
      { startSeconds: 0, stopSeconds: 300, score: 5 },
      { startSeconds: 300, stopSeconds: 600, score: 2 },
    ]);
  });

  it("gives every lineage the DOSE-I device id", () => {
    expect(dose1DepthLineageKey(125)).toContain("dose-i-intellivue");
  });
});

function frames(n: number): ReplayFrame[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i,
    spectrum: [],
    totalPower: 1,
    sef95: 14,
    suppressionRatio: 0,
    isSuppressed: false,
    appIndex: 70,
    coebis: null,
    bis: null,
    coebisLower: null,
    coebisUpper: null,
    coebisSigma: null,
  }));
}

describe("MOAA/S paired points", () => {
  const intervals = [
    { startSeconds: 0, stopSeconds: 400, score: 5 },
    { startSeconds: 400, stopSeconds: 800, score: 1 },
  ];

  it("takes one reading per stride inside the guarded span", () => {
    const built = buildMoaasDepthPoints(frames(800), intervals, {
      caseRef: "10-154",
      channel: "EEG_1",
    });
    expect(built.points.length).toBeGreaterThan(30);
    // Guard band keeps the first reading clear of the run boundary.
    expect(built.points[0]!.atSeconds).toBeGreaterThanOrEqual(30);
    expect(built.points.every((p) => p.atSeconds <= 770)).toBe(true);
    expect(built.scores[5]).toBeGreaterThan(0);
    expect(built.scores[1]).toBeGreaterThan(0);
  });

  it("carries the anchor, its spread and a stable external reference", () => {
    const p = buildMoaasDepthPoints(frames(800), intervals, {
      caseRef: "10-154",
      channel: "EEG_1",
    }).points[0]!;
    expect(p.reference).toBe(93);
    expect(p.referenceSigma).toBe(6);
    expect(p.state).toBe("awake");
    expect(p.externalRef).toMatch(/^zenodo-dose-i:10-154:EEG_1:/);
  });

  it("drops runs too short to settle", () => {
    const built = buildMoaasDepthPoints(
      frames(200),
      [{ startSeconds: 0, stopSeconds: 60, score: 3 }],
      { caseRef: "10-154", channel: "EEG_1" },
    );
    expect(built.points).toHaveLength(0);
    expect(built.rejected.shortInterval).toBe(1);
  });

  it("never invents a reading where the replay produced no index", () => {
    const blank = frames(800).map((f) => ({ ...f, appIndex: null }));
    const built = buildMoaasDepthPoints(blank, intervals, {
      caseRef: "10-154",
      channel: "EEG_1",
    });
    expect(built.points).toHaveLength(0);
    expect(built.rejected.noIndex).toBeGreaterThan(0);
  });
});

describe("clipping guard", () => {
  it("rejects seconds where the amplifier sat on its rails", async () => {
    const { clippedSeconds } = await import("../dose1-raw");
    const fs = 100;
    const samples = new Float64Array(fs * 10);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 3) * 20;
    for (let i = fs * 5; i < fs * 6; i++) samples[i] = 187.5;
    const clipped = clippedSeconds(samples, fs);
    expect(clipped(5.5)).toBe(true);
    // The trailing window is guarded too.
    expect(clipped(7)).toBe(true);
    expect(clipped(2)).toBe(false);
  });

  it("drops clipped readings instead of fitting them", () => {
    const built = buildMoaasDepthPoints(
      frames(800),
      [{ startSeconds: 0, stopSeconds: 800, score: 1 }],
      { caseRef: "10-154", channel: "EEG_1" },
      { clipped: (t) => t > 400 },
    );
    expect(built.points.every((p) => p.atSeconds <= 400)).toBe(true);
    expect(built.rejected.clipped).toBeGreaterThan(0);
  });
});
