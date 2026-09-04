import { describe, expect, it } from "vitest";

import {
  assembleVitalDbNumerics,
  assembleVitalDbWaveform,
  parseVitalDbWaveTrack,
} from "../vitaldb-waveform";

/**
 * VitalDB serves one file per track and stamps a time only on the opening rows
 * of a segment and the final row; everything in between is an implicit grid.
 */
const waveCsv = (values: (number | "")[], step = 0.0078125) =>
  [
    "Time,BIS/EEG1_WAV",
    `0,${values[0] === "" ? "" : values[0]}`,
    `${step},${values[1] === "" ? "" : values[1]}`,
    ...values.slice(2, -1).map((v) => `,${v}`),
    `${step * (values.length - 1)},${values[values.length - 1]}`,
  ].join("\n");

describe("parseVitalDbWaveTrack", () => {
  it("recovers the sample rate from the implicit grid", () => {
    const track = parseVitalDbWaveTrack({
      name: "BIS/EEG1_WAV",
      text: waveCsv([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    expect(track.channel).toBe("AF7");
    expect(track.sampleRate).toBe(128);
    expect(track.startSeconds).toBe(0);
    expect([...track.samples]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("trims a leading gap instead of replaying it as flat line", () => {
    const track = parseVitalDbWaveTrack({
      name: "BIS/EEG1_WAV",
      text: waveCsv(["", "", 3, 4, 5, 6, 7, 8]),
    });
    // Two blank rows at 128 Hz: the recording starts 15.6 ms in, not at zero
    // with two fabricated samples that would read as suppression.
    expect(track.samples.length).toBe(6);
    expect(track.startSeconds).toBeCloseTo(2 / 128, 4);
  });

  it("holds the last sample across an interior gap", () => {
    const track = parseVitalDbWaveTrack({
      name: "BIS/EEG1_WAV",
      text: waveCsv([1, 2, "", "", 5, 6, 7, 8]),
    });
    expect([...track.samples]).toEqual([1, 2, 2, 2, 5, 6, 7, 8]);
  });

  it("rejects a track it cannot place on the montage", () => {
    expect(() => parseVitalDbWaveTrack({ name: "BIS/BIS", text: waveCsv([1, 2, 3]) })).toThrow(
      /Unrecognised/,
    );
  });
});

describe("assembleVitalDbWaveform", () => {
  it("aligns both derivations to their shared start", () => {
    const wave = assembleVitalDbWaveform([
      { name: "BIS/EEG1_WAV", text: waveCsv([1, 2, 3, 4, 5, 6, 7, 8]) },
      { name: "BIS/EEG2_WAV", text: waveCsv(["", "", 3, 4, 5, 6, 7, 8]) },
      { name: "BIS/BIS", text: "Time,BIS/BIS\n0,40\n" },
    ]);
    expect(wave.channels.map((c) => c.channel)).toEqual(["AF7", "AF8"]);
    expect(wave.sampleRate).toBe(128);
    expect(wave.startSeconds).toBeCloseTo(2 / 128, 4);
    expect([...wave.channels[0]!.samples]).toEqual([3, 4, 5, 6, 7, 8]);
    expect([...wave.channels[1]!.samples]).toEqual([3, 4, 5, 6, 7, 8]);
  });
});

describe("assembleVitalDbNumerics", () => {
  it("merges the slow tracks onto one per-second timeline", () => {
    const samples = assembleVitalDbNumerics([
      { name: "BIS/BIS", text: "Time,BIS/BIS\n10,42\n20,38\n" },
      { name: "BIS/SR", text: "Time,BIS/SR\n10,0\n20,12.5\n" },
      { name: "BIS/SQI", text: "Time,BIS/SQI\n10,97\n" },
      { name: "Orchestra/PPF20_CE", text: "Time,Orchestra/PPF20_CE\n20,3.1\n" },
      { name: "BIS/EEG1_WAV", text: "Time,BIS/EEG1_WAV\n10,5\n" },
    ]);
    expect(samples.map((s) => s.t)).toEqual([10, 20]);
    expect(samples[0]).toMatchObject({ bis: 42, sr: 0, sqi: 97 });
    expect(samples[1]).toMatchObject({ bis: 38, sr: 12.5, sqi: null });
    expect(samples[1]!.ce).toEqual({ propofol: 3.1 });
  });
});
