import { describe, expect, it } from "vitest";
import { analyseLabRecording, analyseLabSample, generateLabSample } from "./sample-lab";

describe("sample lab replay", { timeout: 60_000 }, () => {
  it("uses the displayed excerpt of the actual recording and detects its evolving rhythm", () => {
    const recording = generateLabSample("rhythmic");
    const result = analyseLabRecording(recording);
    const start = result.traceStartSeconds * recording.sampleRate;
    expect(result.traces[0]!.values).toEqual(Array.from(recording.channels[0]!.values.subarray(start)));
    expect(result.anySeizureAlert).toBe(true);
    expect(result.peakSeizureScore).toBeGreaterThanOrEqual(0.62);
  });

  it("preserves the underlying waveform after high-frequency interference fades", () => {
    const quiet = generateLabSample("awake");
    const noisy = generateLabSample("emg");
    const lastSecond = (quiet.durationSeconds - 1) * quiet.sampleRate;
    for (const [index, channel] of quiet.channels.entries()) {
      expect(noisy.channels[index]!.values.subarray(lastSecond)).toEqual(channel.values.subarray(lastSecond));
    }
    const result = analyseLabRecording(noisy);
    expect(result.emgBeforePercent!).toBeGreaterThan(result.emgPowerPercent! + 10);
  });

  it("measures bilateral slow-band differences and rolling suppression", () => {
    expect(analyseLabSample("focal").asymmetryPercent).toBeGreaterThan(65);
    const suppression = analyseLabSample("suppression").suppressionPercent;
    expect(suppression).toBeGreaterThan(30);
    expect(suppression).toBeLessThan(80);
  });
});
