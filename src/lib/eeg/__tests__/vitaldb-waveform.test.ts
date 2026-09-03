import { describe, expect, it } from "vitest";

import type { VitalDbCaseInfo, VitalDbTrackSample } from "../vitaldb";
import {
  combineChannels,
  pairVitalDbCase,
  parseVitalDbWaveCsv,
  vitalDbWaveLineage,
  VITALDB_WAVE_SAMPLE_RATE,
} from "../vitaldb-waveform";

const FS = VITALDB_WAVE_SAMPLE_RATE;

function waveCsv(seconds: number): string {
  const rows: string[] = ["Time,SNUADC/EEG1_WAV,SNUADC/EEG2_WAV,BIS/BIS,BIS/SQI"];
  const n = seconds * FS;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const v = 20 * Math.sin(2 * Math.PI * 10 * t);
    const isSecond = i % FS === 0;
    rows.push(`${t.toFixed(4)},${v.toFixed(3)},${(v * 0.9).toFixed(3)},${isSecond ? 45 : ""},${isSecond ? 95 : ""}`);
  }
  return rows.join("\n");
}

const INFO: VitalDbCaseInfo = {
  caseId: "42",
  age: 68,
  sex: "M",
  asa: 3,
  anesthesiaType: "General",
} as VitalDbCaseInfo;

function numerics(seconds: number, sqi = 95): VitalDbTrackSample[] {
  return Array.from({ length: seconds }, (_, t) => ({
    t,
    bis: 45,
    sef: 12,
    sr: 0,
    sqi,
    ce: { propofol: 3 },
  })) as VitalDbTrackSample[];
}

describe("VitalDB waveform parsing", () => {
  it("maps SNUADC EEG tracks onto the frontal analysis channels", () => {
    const wave = parseVitalDbWaveCsv(waveCsv(20));
    expect(wave.channels.map((c) => c.channel)).toEqual(["AF7", "AF8"]);
    expect(wave.sampleRate).toBeCloseTo(FS, 0);
    expect(wave.channels[0]!.samples.length).toBe(20 * FS);
  });

  it("rejects files without waveform columns rather than importing numerics silently", () => {
    expect(() => parseVitalDbWaveCsv("Time,BIS/BIS\n0,45\n1,44\n")).toThrow(/SNUADC/);
  });

  it("holds gaps at the previous sample so blanks do not read as suppression", () => {
    const csv = ["Time,SNUADC/EEG1_WAV", "0,10", "0.0078,", "0.0156,12"].join("\n");
    const wave = parseVitalDbWaveCsv(csv);
    expect(Array.from(wave.channels[0]!.samples)).toEqual([10, 10, 12]);
  });

  it("averages both frontal channels into the analysis signal", () => {
    const combined = combineChannels({
      channels: [
        { channel: "AF7", samples: Float64Array.from([10, 20]) },
        { channel: "AF8", samples: Float64Array.from([20, 40]) },
      ],
      sampleRate: FS,
      startSeconds: 0,
      durationSeconds: 1,
    });
    expect(Array.from(combined)).toEqual([15, 30]);
  });
});

describe("VitalDB waveform pairing", () => {
  it("keeps VitalDB bedside data on its own lineage, never the Muse one", () => {
    const key = vitalDbWaveLineage(["AF7", "AF8"]);
    expect(key.deviceId).toBe("vitaldb-snuadc");
    expect(key.deviceId).not.toContain("muse");
  });

  it("produces paired app-index / BIS readings from a replayed case", () => {
    const wave = parseVitalDbWaveCsv(waveCsv(60));
    const paired = pairVitalDbCase(INFO, wave, numerics(60), { strideSeconds: 10 });
    expect(paired.points.length).toBeGreaterThan(3);
    for (const p of paired.points) {
      expect(p.appIndex).toBeGreaterThan(0);
      expect(p.bis).toBe(45);
      expect(Math.abs(p.lagSeconds)).toBeLessThanOrEqual(2);
      expect(p.externalRef).toContain("42");
    }
    expect(paired.lineageKey).toContain("vitaldb-snuadc");
    expect(paired.covariates.ageBand).toBeTruthy();
  });

  it("honours the stride so one case cannot flood the refit", () => {
    const wave = parseVitalDbWaveCsv(waveCsv(60));
    const dense = pairVitalDbCase(INFO, wave, numerics(60), { strideSeconds: 1 });
    const sparse = pairVitalDbCase(INFO, wave, numerics(60), { strideSeconds: 20 });
    expect(sparse.points.length).toBeLessThan(dense.points.length);
  });

  it("drops readings the bedside monitor itself flagged as poor quality", () => {
    const wave = parseVitalDbWaveCsv(waveCsv(60));
    const paired = pairVitalDbCase(INFO, wave, numerics(60, 10), { minSqi: 50 });
    expect(paired.points).toHaveLength(0);
    expect(paired.rejected.lowSqi).toBeGreaterThan(0);
  });

  it("emits stable external refs so re-importing a case does not duplicate it", () => {
    const wave = parseVitalDbWaveCsv(waveCsv(40));
    const a = pairVitalDbCase(INFO, wave, numerics(40));
    const b = pairVitalDbCase(INFO, wave, numerics(40));
    expect(a.points.map((p) => p.externalRef)).toEqual(b.points.map((p) => p.externalRef));
  });
});
