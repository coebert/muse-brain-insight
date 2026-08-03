import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, EPOCH_SECONDS, EegAnalyzer } from "./analysis";
import { MUSE_SAMPLE_RATE } from "./dsp";

const N = EPOCH_SECONDS * MUSE_SAMPLE_RATE;

function tone(hz: number, amp: number) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = amp * Math.sin((2 * Math.PI * hz * i) / MUSE_SAMPLE_RATE);
  return w;
}
/** Near-isoelectric trace: tiny deterministic ripple so it is not read as a dropout. */
function suppressed(amp = 2) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = amp * Math.sin((2 * Math.PI * 9 * i) / MUSE_SAMPLE_RATE);
  return w;
}

describe("EegAnalyzer", () => {
  it("reports a plausible SEF95 for an anaesthetic alpha/delta pattern", () => {
    const a = new EegAnalyzer();
    const w = new Float64Array(N);
    const slow = tone(1.5, 40);
    const alpha = tone(10, 20);
    for (let i = 0; i < N; i++) w[i] = slow[i]! + alpha[i]!;
    const epoch = a.analyze(w, EPOCH_SECONDS);
    expect(epoch.sef95).toBeGreaterThan(1);
    expect(epoch.sef95).toBeLessThan(30);
    expect(epoch.spectrum.length).toBeGreaterThan(10);
  });

  it("drives the suppression ratio towards 100% on an isoelectric trace", () => {
    const a = new EegAnalyzer();
    let last = a.analyze(suppressed(), 0);
    for (let t = 1; t <= 40; t++) last = a.analyze(suppressed(), t);
    expect(last.isSuppressed).toBe(true);
    expect(last.suppressionRatio).toBeGreaterThan(90);
  });

  it("keeps the suppression ratio at zero for continuous activity", () => {
    const a = new EegAnalyzer();
    let last = a.analyze(tone(10, 40), 0);
    for (let t = 1; t <= 20; t++) last = a.analyze(tone(10, 40), t);
    expect(last.isSuppressed).toBe(false);
    expect(last.suppressionRatio).toBeLessThan(5);
  });

  it("reset() clears accumulated suppression burden", () => {
    const a = new EegAnalyzer();
    for (let t = 0; t <= 20; t++) a.analyze(suppressed(), t);
    expect(a.suppressionSeconds).toBeGreaterThan(10);
    a.reset();
    expect(a.suppressionSeconds).toBe(0);
    const fresh = a.analyze(tone(10, 40), 0);
    expect(fresh.suppressionRatio).toBeLessThan(5);
  });

  it("honours a lower suppression amplitude floor", () => {
    const quiet = tone(10, 3);
    const strict = new EegAnalyzer({ ...DEFAULT_SETTINGS, suppressionThresholdUv: 2 });
    const loose = new EegAnalyzer({ ...DEFAULT_SETTINGS, suppressionThresholdUv: 20 });
    let s = strict.analyze(quiet, 0);
    let l = loose.analyze(quiet, 0);
    for (let t = 1; t <= 15; t++) {
      s = strict.analyze(quiet, t);
      l = loose.analyze(quiet, t);
    }
    expect(l.suppressionRatio).toBeGreaterThan(s.suppressionRatio);
  });

  it("suppresses the seizure score while the trace is suppressed", () => {
    const a = new EegAnalyzer();
    let last = a.analyze(suppressed(), 0);
    for (let t = 1; t <= 20; t++) last = a.analyze(suppressed(), t);
    expect(last.isSuppressed).toBe(true);
    expect(last.seizureScore).toBe(0);
  });

  it("keeps the seizure score within 0..1 for high-amplitude rhythmic activity", () => {
    const a = new EegAnalyzer();
    let last = a.analyze(tone(3, 120), 0);
    for (let t = 1; t <= 10; t++) last = a.analyze(tone(3, 120), t);
    expect(last.seizureScore).toBeGreaterThanOrEqual(0);
    expect(last.seizureScore).toBeLessThanOrEqual(1);
  });
});
