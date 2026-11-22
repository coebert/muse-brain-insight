import { describe, expect, it } from "vitest";
import { getActiveKetamineExposure, setActiveKetamineExposure } from "./depth";
import { analyseLabRecording, generateLabSample, type LabRecording } from "./sample-lab";

function excerpt(recording: LabRecording, from: number, to: number): LabRecording {
  return {
    sampleRate: recording.sampleRate,
    durationSeconds: to - from,
    channels: recording.channels.map(({ label, values }) => ({
      label,
      values: values.subarray(from * recording.sampleRate, to * recording.sampleRate),
    })),
  };
}

describe("sample lab replay", { timeout: 60_000 }, () => {
  it("uses the displayed excerpt of the actual recording and detects its evolving rhythm", () => {
    const recording = excerpt(generateLabSample("rhythmic"), 28, 60);
    const result = analyseLabRecording(recording);
    const start = result.traceStartSeconds * recording.sampleRate;
    expect(result.traces[0]!.values).toEqual(
      Array.from(recording.channels[0]!.values.subarray(start)),
    );
    expect(result.initialTraces[0]!.values).toEqual(
      Array.from(
        recording.channels[0]!.values.subarray(0, result.traceSeconds * recording.sampleRate),
      ),
    );
    expect(result.anySeizureAlert).toBe(true);
    expect(result.peakSeizureScore).toBeGreaterThanOrEqual(0.62);
  });

  it("preserves the underlying waveform after high-frequency interference fades", () => {
    const quiet = generateLabSample("awake");
    const noisy = generateLabSample("emg");
    const lastSecond = (quiet.durationSeconds - 1) * quiet.sampleRate;
    for (const [index, channel] of quiet.channels.entries()) {
      expect(noisy.channels[index]!.values.subarray(lastSecond)).toEqual(
        channel.values.subarray(lastSecond),
      );
    }
    const result = analyseLabRecording(excerpt(noisy, 32, 48));
    expect(result.emgBeforePercent!).toBeGreaterThan(result.emgPowerPercent! + 10);
  });

  it("measures bilateral slow-band differences and rolling suppression", () => {
    expect(
      analyseLabRecording(excerpt(generateLabSample("focal"), 0, 8)).asymmetryPercent,
    ).toBeGreaterThan(65);
    const suppression = analyseLabRecording(
      excerpt(generateLabSample("suppression"), 0, 21),
    ).suppressionPercent;
    expect(suppression).toBeGreaterThan(30);
    expect(suppression).toBeLessThan(80);
  });

  it("changes only the declared-exposure stage on the same waveform and restores case context", () => {
    const original = getActiveKetamineExposure();
    try {
      setActiveKetamineExposure("declared");
      const recording = excerpt(generateLabSample("activated"), 0, 16);
      const result = analyseLabRecording(recording, true);
      expect(getActiveKetamineExposure()).toBe("declared");
      expect(result.exposure?.unrecorded).toMatchObject({
        delta: 0,
        advisory: true,
        corrected: false,
      });
      expect(result.exposure?.declared.corrected).toBe(true);
      expect(result.exposure?.declared.delta).toBeLessThan(0);
      expect(result.exposure?.declared.delta).toBeGreaterThanOrEqual(-12);
      expect(result.exposure?.declared.coebis).toBeLessThan(result.exposure!.unrecorded.coebis!);
      expect(result.exposure?.bands.slow).toBeGreaterThan(20);
      expect(result.exposure?.bands.beta).toBeGreaterThan(15);
      expect(result.exposure?.bands.gamma).toBeGreaterThan(0);
    } finally {
      setActiveKetamineExposure(original);
    }
  });

  it("withholds the exposure comparison when the waveform is unusable", () => {
    const sampleRate = 256;
    const values = Float64Array.from({ length: 4 * sampleRate }, (_, i) => 5000 * Math.sin(i / 5));
    const channels = ["AF7", "AF8"].map((label) => ({ label, values }));
    const { exposure } = analyseLabRecording({ sampleRate, durationSeconds: 4, channels }, true);
    expect(exposure?.unrecorded.coebis).toBeNull();
    expect(exposure?.declared).toMatchObject({ coebis: null, delta: null, corrected: false });
  });
});
